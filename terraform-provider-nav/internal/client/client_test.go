package client

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func newTestClient(t *testing.T, h http.HandlerFunc) (*Client, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	c, err := New(srv.URL, "nav_test", WithRetry(3, time.Millisecond, 5*time.Millisecond))
	if err != nil {
		t.Fatal(err)
	}
	return c, srv
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func TestNewBaseURL(t *testing.T) {
	cases := map[string]string{
		"http://localhost:4000":          "http://localhost:4000/api/v1",
		"http://localhost:4000/":         "http://localhost:4000/api/v1",
		"https://nav.example.com/api/v1": "https://nav.example.com/api/v1",
	}
	for in, want := range cases {
		c, err := New(in, "")
		if err != nil {
			t.Fatalf("New(%q): %v", in, err)
		}
		if c.BaseURL() != want {
			t.Errorf("New(%q).BaseURL() = %q, want %q", in, c.BaseURL(), want)
		}
	}
	for _, bad := range []string{"", "localhost:4000", "ftp://x"} {
		if _, err := New(bad, ""); err == nil {
			t.Errorf("New(%q) should fail", bad)
		}
	}
}

func TestAuthHeaderAndDecode(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer nav_test" {
			t.Errorf("Authorization = %q", got)
		}
		if r.URL.Path != "/api/v1/services/srv_1" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		writeJSON(w, 200, map[string]any{
			"id": "srv_1", "name": "api", "type": "web", "runtime": "node", "plan": "starter", "instanceCount": 2,
			"port": nil, "repoUrl": "https://github.com/acme/api", "autoscaling": map[string]any{"enabled": true, "min": 1, "max": 3, "targetCpuPercent": 70, "targetMemoryPercent": nil},
			"disk": map[string]any{"name": "data", "mountPath": "/data", "sizeGB": 5},
		})
	})
	s, err := c.GetService(context.Background(), "srv_1")
	if err != nil {
		t.Fatal(err)
	}
	if s.Name != "api" || s.InstanceCount != 2 || s.Port != nil || s.RepoURL == nil || *s.RepoURL != "https://github.com/acme/api" {
		t.Errorf("bad decode: %+v", s)
	}
	if s.Autoscaling == nil || !s.Autoscaling.Enabled || s.Autoscaling.TargetCPUPercent == nil || *s.Autoscaling.TargetCPUPercent != 70 || s.Autoscaling.TargetMemoryPercent != nil {
		t.Errorf("bad autoscaling: %+v", s.Autoscaling)
	}
	if s.Disk == nil || s.Disk.SizeGB != 5 {
		t.Errorf("bad disk: %+v", s.Disk)
	}
}

func TestErrorParsingAndNotFound(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 404, map[string]any{"error": map[string]any{"code": "not_found", "message": "service not found"}})
	})
	_, err := c.GetService(context.Background(), "srv_missing")
	if !IsNotFound(err) {
		t.Fatalf("expected not found, got %v", err)
	}
	if !strings.Contains(err.Error(), "service not found") {
		t.Errorf("error text %q lacks the API message", err.Error())
	}
}

func TestValidationErrorNotRetried(t *testing.T) {
	var calls int32
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		writeJSON(w, 400, map[string]any{"error": map[string]any{"code": "validation_error", "message": "name: Required"}})
	})
	_, err := c.CreateEnvGroup(context.Background(), "ws_1", CreateEnvGroupInput{})
	if StatusCode(err) != 400 {
		t.Fatalf("expected 400, got %v", err)
	}
	if calls != 1 {
		t.Errorf("calls = %d, want 1", calls)
	}
}

func TestRetriesOn429ThenSucceeds(t *testing.T) {
	var calls int32
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&calls, 1) < 3 {
			w.Header().Set("Retry-After", "0")
			writeJSON(w, 429, map[string]any{"error": map[string]any{"code": "rate_limited", "message": "slow down"}})
			return
		}
		writeJSON(w, 201, map[string]any{"id": "prj_1", "name": "shop", "environments": []any{map[string]any{"id": "env_1", "projectId": "prj_1", "name": "production"}}})
	})
	p, err := c.CreateProject(context.Background(), "ws_1", "shop", nil)
	if err != nil {
		t.Fatal(err)
	}
	if calls != 3 || p.ID != "prj_1" || len(p.Environments) != 1 {
		t.Errorf("calls=%d project=%+v", calls, p)
	}
}

func TestRetriesOn5xxForGetUntilExhausted(t *testing.T) {
	var calls int32
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		writeJSON(w, 502, map[string]any{"error": map[string]any{"code": "bad_gateway", "message": "upstream"}})
	})
	_, err := c.GetDatabase(context.Background(), "dpg_1")
	if StatusCode(err) != 502 {
		t.Fatalf("expected 502, got %v", err)
	}
	if calls != 4 { // first try + 3 retries
		t.Errorf("calls = %d, want 4", calls)
	}
}

func TestNoRetryOn500ForPost(t *testing.T) {
	var calls int32
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		writeJSON(w, 500, map[string]any{"error": map[string]any{"code": "internal", "message": "boom"}})
	})
	_, err := c.CreateService(context.Background(), "ws_1", CreateServiceInput{Name: "x", Type: "web"})
	if StatusCode(err) != 500 {
		t.Fatalf("expected 500, got %v", err)
	}
	if calls != 1 {
		t.Errorf("POST was retried: calls = %d", calls)
	}
}

func TestContextCancelStopsRetrying(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "30")
		writeJSON(w, 429, map[string]any{})
	}))
	defer srv.Close()
	c, err := New(srv.URL, "nav_test", WithRetry(5, time.Second, 30*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err = c.ListWorkspaces(ctx)
	if err != context.DeadlineExceeded {
		t.Fatalf("expected context.DeadlineExceeded, got %v", err)
	}
	if time.Since(start) > 2*time.Second {
		t.Errorf("did not honour context cancellation")
	}
}

func TestCreateServiceBodyAndUnwrap(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/workspaces/ws_1/services" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["name"] != "api" || body["type"] != "web" {
			t.Errorf("body = %v", body)
		}
		if _, ok := body["port"]; ok {
			t.Errorf("unset optional field port was sent: %v", body)
		}
		vars, _ := body["envVars"].([]any)
		if len(vars) != 1 {
			t.Errorf("envVars = %v", body["envVars"])
		}
		writeJSON(w, 201, map[string]any{"service": map[string]any{"id": "srv_9", "name": "api", "type": "web"}, "deploy": map[string]any{"id": "dep_1"}})
	})
	s, err := c.CreateService(context.Background(), "ws_1", CreateServiceInput{Name: "api", Type: "web", EnvVars: []EnvVar{{Key: "A", Value: "1"}}})
	if err != nil {
		t.Fatal(err)
	}
	if s.ID != "srv_9" {
		t.Errorf("id = %q", s.ID)
	}
}

func TestUpdateServiceSendsExplicitNulls(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		for _, k := range []string{"buildCommand", "port", "disk", "environmentId", "registryCredentialId"} {
			v, ok := body[k]
			if !ok || v != nil {
				t.Errorf("%s should be sent as null, body=%s", k, raw)
			}
		}
		if _, ok := body["autoscaling"]; ok {
			t.Errorf("autoscaling should be omitted when nil, body=%s", raw)
		}
		writeJSON(w, 200, map[string]any{"id": "srv_1"})
	})
	name := "renamed"
	if _, err := c.UpdateService(context.Background(), "srv_1", UpdateServiceInput{Name: &name}); err != nil {
		t.Fatal(err)
	}
}

func TestLogStreamTokenNull(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(raw), `"token":null`) {
			t.Errorf("token should be null: %s", raw)
		}
		writeJSON(w, 200, map[string]any{"id": "lgs_1", "protocol": "https", "endpoint": "https://logs.example.com", "hasToken": false, "enabled": true})
	})
	ls, err := c.PutWorkspaceLogStream(context.Background(), "ws_1", LogStreamInput{Protocol: "https", Endpoint: "https://logs.example.com", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	if ls.ID != "lgs_1" || ls.HasToken {
		t.Errorf("bad stream %+v", ls)
	}
}

func TestListLookupsReturnNotFound(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/workspaces/ws_1/projects":
			writeJSON(w, 200, map[string]any{"items": []any{map[string]any{"id": "prj_1", "environments": []any{map[string]any{"id": "env_1", "projectId": "prj_1", "name": "production"}}}}, "nextCursor": nil})
		case "/api/v1/workspaces/ws_1/webhooks":
			writeJSON(w, 200, map[string]any{"items": []any{}})
		default:
			writeJSON(w, 404, map[string]any{})
		}
	})
	ctx := context.Background()
	if env, err := c.GetEnvironment(ctx, "ws_1", "env_1"); err != nil || env.Name != "production" {
		t.Errorf("GetEnvironment = %+v, %v", env, err)
	}
	if _, err := c.GetProject(ctx, "ws_1", "prj_2"); !IsNotFound(err) {
		t.Errorf("GetProject missing: %v", err)
	}
	if _, err := c.GetWebhook(ctx, "ws_1", "whk_1"); !IsNotFound(err) {
		t.Errorf("GetWebhook missing: %v", err)
	}
}

func TestDeleteNoContent(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/api/v1/env-groups/evg_1" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	})
	if err := c.DeleteEnvGroup(context.Background(), "evg_1"); err != nil {
		t.Fatal(err)
	}
}

func TestPathEscaping(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RawPath != "" && !strings.Contains(r.URL.RawPath, "%2F") {
			t.Errorf("id was not escaped: %s", r.URL.RawPath)
		}
		writeJSON(w, 404, map[string]any{})
	})
	if _, err := c.GetService(context.Background(), "a/b"); !IsNotFound(err) {
		t.Errorf("expected 404, got %v", err)
	}
}

func TestParseRetryAfter(t *testing.T) {
	if d := parseRetryAfter("3"); d != 3*time.Second {
		t.Errorf("parseRetryAfter(3) = %v", d)
	}
	if d := parseRetryAfter("nonsense"); d != 0 {
		t.Errorf("parseRetryAfter(nonsense) = %v", d)
	}
}
