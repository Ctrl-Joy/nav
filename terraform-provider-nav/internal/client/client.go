// Package client is a small typed client for the NAV REST API (/api/v1).
//
// It covers the endpoints the Terraform provider needs, authenticates with a
// bearer API key (nav_...) and retries rate-limited and transient failures.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	defaultMaxRetries = 4
	defaultMinBackoff = 500 * time.Millisecond
	defaultMaxBackoff = 15 * time.Second
	maxResponseBytes  = 32 << 20
)

// Client talks to one NAV control plane.
type Client struct {
	baseURL    string
	token      string
	userAgent  string
	httpClient *http.Client
	maxRetries int
	minBackoff time.Duration
	maxBackoff time.Duration
}

// Option customises a Client.
type Option func(*Client)

// WithHTTPClient replaces the underlying *http.Client.
func WithHTTPClient(h *http.Client) Option { return func(c *Client) { c.httpClient = h } }

// WithUserAgent sets the User-Agent header.
func WithUserAgent(ua string) Option { return func(c *Client) { c.userAgent = ua } }

// WithRetry sets how many times a request is retried and the backoff bounds.
func WithRetry(maxRetries int, minBackoff, maxBackoff time.Duration) Option {
	return func(c *Client) {
		c.maxRetries = maxRetries
		c.minBackoff = minBackoff
		c.maxBackoff = maxBackoff
	}
}

// New builds a client for host (e.g. "https://nav.example.com"). "/api/v1" is
// appended unless host already ends with it.
func New(host, token string, opts ...Option) (*Client, error) {
	host = strings.TrimSpace(host)
	if host == "" {
		return nil, errors.New("host is required")
	}
	u, err := url.Parse(host)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("host %q must be an absolute http(s) URL", host)
	}
	base := strings.TrimRight(host, "/")
	if !strings.HasSuffix(base, "/api/v1") {
		base += "/api/v1"
	}
	c := &Client{
		baseURL:    base,
		token:      token,
		userAgent:  "terraform-provider-nav",
		httpClient: &http.Client{Timeout: 60 * time.Second},
		maxRetries: defaultMaxRetries,
		minBackoff: defaultMinBackoff,
		maxBackoff: defaultMaxBackoff,
	}
	for _, o := range opts {
		o(c)
	}
	return c, nil
}

// BaseURL returns the API base URL, including /api/v1.
func (c *Client) BaseURL() string { return c.baseURL }

// APIError is a non-2xx answer from the API.
type APIError struct {
	StatusCode int
	Code       string
	Message    string
	Method     string
	Path       string
}

func (e *APIError) Error() string {
	msg := e.Message
	if msg == "" {
		msg = http.StatusText(e.StatusCode)
	}
	if e.Code != "" {
		return fmt.Sprintf("NAV API %s %s: %d %s: %s", e.Method, e.Path, e.StatusCode, e.Code, msg)
	}
	return fmt.Sprintf("NAV API %s %s: %d: %s", e.Method, e.Path, e.StatusCode, msg)
}

// IsNotFound reports whether err is an API 404.
func IsNotFound(err error) bool { return StatusCode(err) == http.StatusNotFound }

// StatusCode returns the HTTP status of an *APIError in err's chain, or 0.
func StatusCode(err error) int {
	var ae *APIError
	if errors.As(err, &ae) {
		return ae.StatusCode
	}
	return 0
}

func notFound(method, path, what string) error {
	return &APIError{StatusCode: http.StatusNotFound, Code: "not_found", Message: what + " not found", Method: method, Path: path}
}

// shouldRetry decides whether a response status is worth retrying. Rate
// limiting (429) and 503 are always retried. Other 5xx answers are retried for
// idempotent methods only, so a POST that may have been applied is not repeated.
func shouldRetry(method string, status int) bool {
	switch {
	case status == http.StatusTooManyRequests, status == http.StatusServiceUnavailable:
		return true
	case status >= 500:
		return idempotent(method)
	}
	return false
}

func idempotent(method string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPut, http.MethodDelete, http.MethodOptions:
		return true
	}
	return false
}

func (c *Client) backoff(attempt int, retryAfter string) time.Duration {
	d := c.minBackoff << uint(attempt)
	if d <= 0 || d > c.maxBackoff {
		d = c.maxBackoff
	}
	if d > 0 {
		// Up to 20% jitter so parallel resources do not retry in lockstep.
		d += time.Duration(rand.Int63n(int64(d)/5 + 1))
	}
	if ra := parseRetryAfter(retryAfter); ra > d {
		d = ra
	}
	if limit := 2 * c.maxBackoff; limit > 0 && d > limit {
		d = limit
	}
	return d
}

func parseRetryAfter(v string) time.Duration {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	if secs, err := strconv.Atoi(v); err == nil && secs >= 0 {
		return time.Duration(secs) * time.Second
	}
	if t, err := http.ParseTime(v); err == nil {
		if d := time.Until(t); d > 0 {
			return d
		}
	}
	return 0
}

func sleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// do sends one API request, retrying where allowed, and decodes a JSON answer into out.
func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return fmt.Errorf("encoding request body: %w", err)
		}
	}
	for attempt := 0; ; attempt++ {
		var rdr io.Reader
		if payload != nil {
			rdr = bytes.NewReader(payload)
		}
		req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, rdr)
		if err != nil {
			return err
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", c.userAgent)
		if c.token != "" {
			req.Header.Set("Authorization", "Bearer "+c.token)
		}
		if payload != nil {
			req.Header.Set("Content-Type", "application/json")
		}

		resp, err := c.httpClient.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if attempt < c.maxRetries && idempotent(method) {
				if serr := sleep(ctx, c.backoff(attempt, "")); serr != nil {
					return serr
				}
				continue
			}
			return fmt.Errorf("NAV API %s %s: %w", method, path, err)
		}
		data, readErr := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
		_ = resp.Body.Close()

		if shouldRetry(method, resp.StatusCode) && attempt < c.maxRetries {
			if serr := sleep(ctx, c.backoff(attempt, resp.Header.Get("Retry-After"))); serr != nil {
				return serr
			}
			continue
		}
		if resp.StatusCode >= 400 {
			return parseError(method, path, resp.StatusCode, data)
		}
		if readErr != nil {
			return fmt.Errorf("NAV API %s %s: reading response: %w", method, path, readErr)
		}
		if out != nil && len(bytes.TrimSpace(data)) > 0 {
			if err := json.Unmarshal(data, out); err != nil {
				return fmt.Errorf("NAV API %s %s: decoding response: %w", method, path, err)
			}
		}
		return nil
	}
}

func parseError(method, path string, status int, data []byte) error {
	e := &APIError{StatusCode: status, Method: method, Path: path}
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(data, &body) == nil && (body.Error.Code != "" || body.Error.Message != "") {
		e.Code = body.Error.Code
		e.Message = body.Error.Message
	} else if s := strings.TrimSpace(string(data)); s != "" && len(s) < 500 {
		e.Message = s
	}
	return e
}

func esc(s string) string { return url.PathEscape(s) }
