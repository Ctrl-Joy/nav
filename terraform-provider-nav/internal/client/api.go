package client

import (
	"context"
	"net/http"
)

type items[T any] struct {
	Items []T `json:"items"`
}

// ---- Workspaces --------------------------------------------------------------

func (c *Client) ListWorkspaces(ctx context.Context) ([]Workspace, error) {
	var out items[Workspace]
	err := c.do(ctx, http.MethodGet, "/workspaces", nil, &out)
	return out.Items, err
}

// ---- Projects & environments --------------------------------------------------

func (c *Client) ListProjects(ctx context.Context, workspaceID string) ([]Project, error) {
	var out items[Project]
	err := c.do(ctx, http.MethodGet, "/workspaces/"+esc(workspaceID)+"/projects", nil, &out)
	return out.Items, err
}

func (c *Client) CreateProject(ctx context.Context, workspaceID, name string, environments []string) (*Project, error) {
	body := map[string]any{"name": name}
	if len(environments) > 0 {
		body["environments"] = environments
	}
	var out Project
	if err := c.do(ctx, http.MethodPost, "/workspaces/"+esc(workspaceID)+"/projects", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetProject finds a project in its workspace (the API has no single-project GET).
func (c *Client) GetProject(ctx context.Context, workspaceID, id string) (*Project, error) {
	list, err := c.ListProjects(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	for i := range list {
		if list[i].ID == id {
			return &list[i], nil
		}
	}
	return nil, notFound(http.MethodGet, "/projects/"+id, "project")
}

func (c *Client) UpdateProject(ctx context.Context, id, name string) error {
	return c.do(ctx, http.MethodPatch, "/projects/"+esc(id), map[string]any{"name": name}, nil)
}

func (c *Client) DeleteProject(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/projects/"+esc(id), nil, nil)
}

func (c *Client) CreateEnvironment(ctx context.Context, projectID, name string, protected bool) (*Environment, error) {
	var out Environment
	err := c.do(ctx, http.MethodPost, "/projects/"+esc(projectID)+"/environments", map[string]any{"name": name, "protected": protected}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// GetEnvironment finds an environment among the workspace's projects.
func (c *Client) GetEnvironment(ctx context.Context, workspaceID, id string) (*Environment, error) {
	list, err := c.ListProjects(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	for _, p := range list {
		for i := range p.Environments {
			if p.Environments[i].ID == id {
				return &p.Environments[i], nil
			}
		}
	}
	return nil, notFound(http.MethodGet, "/environments/"+id, "environment")
}

func (c *Client) DeleteEnvironment(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/environments/"+esc(id), nil, nil)
}

// ---- Services -------------------------------------------------------------------

func (c *Client) ListServices(ctx context.Context, workspaceID string) ([]Service, error) {
	var out items[Service]
	err := c.do(ctx, http.MethodGet, "/workspaces/"+esc(workspaceID)+"/services", nil, &out)
	return out.Items, err
}

// CreateService creates a service; the API queues its first deploy.
func (c *Client) CreateService(ctx context.Context, workspaceID string, in CreateServiceInput) (*Service, error) {
	var out struct {
		Service Service `json:"service"`
	}
	if err := c.do(ctx, http.MethodPost, "/workspaces/"+esc(workspaceID)+"/services", in, &out); err != nil {
		return nil, err
	}
	return &out.Service, nil
}

func (c *Client) GetService(ctx context.Context, id string) (*Service, error) {
	var out Service
	if err := c.do(ctx, http.MethodGet, "/services/"+esc(id), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateService(ctx context.Context, id string, in UpdateServiceInput) (*Service, error) {
	var out Service
	if err := c.do(ctx, http.MethodPatch, "/services/"+esc(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteService(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/services/"+esc(id), nil, nil)
}

func (c *Client) GetServiceEnvVars(ctx context.Context, id string) ([]EnvVar, error) {
	var out items[EnvVar]
	err := c.do(ctx, http.MethodGet, "/services/"+esc(id)+"/env-vars", nil, &out)
	return out.Items, err
}

// SetServiceEnvVars replaces the full set; when deploy is true the API queues an env_change deploy.
func (c *Client) SetServiceEnvVars(ctx context.Context, id string, vars []EnvVar, deploy bool) error {
	if vars == nil {
		vars = []EnvVar{}
	}
	return c.do(ctx, http.MethodPut, "/services/"+esc(id)+"/env-vars", map[string]any{"envVars": vars, "deploy": deploy}, nil)
}

func (c *Client) GetServiceSecretFiles(ctx context.Context, id string) ([]SecretFile, error) {
	var out items[SecretFile]
	err := c.do(ctx, http.MethodGet, "/services/"+esc(id)+"/secret-files", nil, &out)
	return out.Items, err
}

func (c *Client) SetServiceSecretFiles(ctx context.Context, id string, files []SecretFile, deploy bool) error {
	if files == nil {
		files = []SecretFile{}
	}
	return c.do(ctx, http.MethodPut, "/services/"+esc(id)+"/secret-files", map[string]any{"secretFiles": files, "deploy": deploy}, nil)
}

func (c *Client) GetServiceEnvGroups(ctx context.Context, id string) ([]EnvGroupRef, error) {
	var out items[EnvGroupRef]
	err := c.do(ctx, http.MethodGet, "/services/"+esc(id)+"/env-groups", nil, &out)
	return out.Items, err
}

func (c *Client) SetServiceEnvGroups(ctx context.Context, id string, groupIDs []string) error {
	if groupIDs == nil {
		groupIDs = []string{}
	}
	return c.do(ctx, http.MethodPut, "/services/"+esc(id)+"/env-groups", map[string]any{"groupIds": groupIDs}, nil)
}

// ---- Custom domains -------------------------------------------------------------

func (c *Client) ListCustomDomains(ctx context.Context, serviceID string) ([]CustomDomain, error) {
	var out items[CustomDomain]
	err := c.do(ctx, http.MethodGet, "/services/"+esc(serviceID)+"/custom-domains", nil, &out)
	return out.Items, err
}

// CreateCustomDomain adds a domain. For an apex domain the API also adds a
// www. redirect; the requested domain is always the first item returned.
func (c *Client) CreateCustomDomain(ctx context.Context, serviceID, domain string) ([]CustomDomain, error) {
	var out items[CustomDomain]
	err := c.do(ctx, http.MethodPost, "/services/"+esc(serviceID)+"/custom-domains", map[string]any{"domain": domain}, &out)
	return out.Items, err
}

func (c *Client) GetCustomDomain(ctx context.Context, serviceID, id string) (*CustomDomain, error) {
	list, err := c.ListCustomDomains(ctx, serviceID)
	if err != nil {
		return nil, err
	}
	for i := range list {
		if list[i].ID == id {
			return &list[i], nil
		}
	}
	return nil, notFound(http.MethodGet, "/custom-domains/"+id, "custom domain")
}

func (c *Client) VerifyCustomDomain(ctx context.Context, id string) (*CustomDomain, error) {
	var out CustomDomain
	if err := c.do(ctx, http.MethodPost, "/custom-domains/"+esc(id)+"/verify", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteCustomDomain(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/custom-domains/"+esc(id), nil, nil)
}

// ---- Env groups -------------------------------------------------------------------

func (c *Client) ListEnvGroups(ctx context.Context, workspaceID string) ([]EnvGroup, error) {
	var out items[EnvGroup]
	err := c.do(ctx, http.MethodGet, "/workspaces/"+esc(workspaceID)+"/env-groups", nil, &out)
	return out.Items, err
}

func (c *Client) CreateEnvGroup(ctx context.Context, workspaceID string, in CreateEnvGroupInput) (*EnvGroup, error) {
	var out EnvGroup
	if err := c.do(ctx, http.MethodPost, "/workspaces/"+esc(workspaceID)+"/env-groups", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) GetEnvGroup(ctx context.Context, id string) (*EnvGroup, error) {
	var out EnvGroup
	if err := c.do(ctx, http.MethodGet, "/env-groups/"+esc(id), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// UpdateEnvGroup patches a group; linked services redeploy when vars or files change.
func (c *Client) UpdateEnvGroup(ctx context.Context, id string, in UpdateEnvGroupInput) (*EnvGroup, error) {
	var out EnvGroup
	if err := c.do(ctx, http.MethodPatch, "/env-groups/"+esc(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteEnvGroup(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/env-groups/"+esc(id), nil, nil)
}

// ---- Postgres ----------------------------------------------------------------------

func (c *Client) ListDatabases(ctx context.Context, workspaceID string) ([]Database, error) {
	var out items[Database]
	err := c.do(ctx, http.MethodGet, "/workspaces/"+esc(workspaceID)+"/databases", nil, &out)
	return out.Items, err
}

func (c *Client) CreateDatabase(ctx context.Context, workspaceID string, in CreateDatabaseInput) (*Database, error) {
	var out Database
	if err := c.do(ctx, http.MethodPost, "/workspaces/"+esc(workspaceID)+"/databases", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) GetDatabase(ctx context.Context, id string) (*Database, error) {
	var out Database
	if err := c.do(ctx, http.MethodGet, "/databases/"+esc(id), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateDatabase(ctx context.Context, id string, in UpdateDatabaseInput) (*Database, error) {
	var out Database
	if err := c.do(ctx, http.MethodPatch, "/databases/"+esc(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteDatabase(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/databases/"+esc(id), nil, nil)
}

// GetDatabaseCredentials needs developer access; the API answers 409 until the database is available.
func (c *Client) GetDatabaseCredentials(ctx context.Context, id string) (*DatabaseCredentials, error) {
	var out DatabaseCredentials
	if err := c.do(ctx, http.MethodGet, "/databases/"+esc(id)+"/credentials", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ---- Key Value ----------------------------------------------------------------------

func (c *Client) CreateKeyValue(ctx context.Context, workspaceID string, in CreateKeyValueInput) (*KeyValue, error) {
	var out KeyValue
	if err := c.do(ctx, http.MethodPost, "/workspaces/"+esc(workspaceID)+"/key-value", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) GetKeyValue(ctx context.Context, id string) (*KeyValue, error) {
	var out KeyValue
	if err := c.do(ctx, http.MethodGet, "/key-value/"+esc(id), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateKeyValue(ctx context.Context, id string, in UpdateKeyValueInput) (*KeyValue, error) {
	var out KeyValue
	if err := c.do(ctx, http.MethodPatch, "/key-value/"+esc(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteKeyValue(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/key-value/"+esc(id), nil, nil)
}

func (c *Client) GetKeyValueCredentials(ctx context.Context, id string) (*KeyValueCredentials, error) {
	var out KeyValueCredentials
	if err := c.do(ctx, http.MethodGet, "/key-value/"+esc(id)+"/credentials", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ---- Registry credentials ---------------------------------------------------------------

func (c *Client) ListRegistryCredentials(ctx context.Context, workspaceID string) ([]RegistryCredential, error) {
	var out items[RegistryCredential]
	err := c.do(ctx, http.MethodGet, "/workspaces/"+esc(workspaceID)+"/registry-credentials", nil, &out)
	return out.Items, err
}

func (c *Client) GetRegistryCredential(ctx context.Context, workspaceID, id string) (*RegistryCredential, error) {
	list, err := c.ListRegistryCredentials(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	for i := range list {
		if list[i].ID == id {
			return &list[i], nil
		}
	}
	return nil, notFound(http.MethodGet, "/registry-credentials/"+id, "registry credential")
}

func (c *Client) CreateRegistryCredential(ctx context.Context, workspaceID string, in RegistryCredentialInput) (*RegistryCredential, error) {
	var out RegistryCredential
	if err := c.do(ctx, http.MethodPost, "/workspaces/"+esc(workspaceID)+"/registry-credentials", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateRegistryCredential(ctx context.Context, id string, in RegistryCredentialInput) (*RegistryCredential, error) {
	var out RegistryCredential
	if err := c.do(ctx, http.MethodPatch, "/registry-credentials/"+esc(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteRegistryCredential(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/registry-credentials/"+esc(id), nil, nil)
}

// ---- Webhooks ------------------------------------------------------------------------------

func (c *Client) ListWebhooks(ctx context.Context, workspaceID string) ([]Webhook, error) {
	var out items[Webhook]
	err := c.do(ctx, http.MethodGet, "/workspaces/"+esc(workspaceID)+"/webhooks", nil, &out)
	return out.Items, err
}

func (c *Client) GetWebhook(ctx context.Context, workspaceID, id string) (*Webhook, error) {
	list, err := c.ListWebhooks(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	for i := range list {
		if list[i].ID == id {
			return &list[i], nil
		}
	}
	return nil, notFound(http.MethodGet, "/webhooks/"+id, "webhook")
}

// CreateWebhook returns the webhook and its signing secret.
func (c *Client) CreateWebhook(ctx context.Context, workspaceID string, in WebhookInput) (*Webhook, string, error) {
	var out struct {
		Webhook Webhook `json:"webhook"`
		Secret  string  `json:"secret"`
	}
	if err := c.do(ctx, http.MethodPost, "/workspaces/"+esc(workspaceID)+"/webhooks", in, &out); err != nil {
		return nil, "", err
	}
	return &out.Webhook, out.Secret, nil
}

func (c *Client) UpdateWebhook(ctx context.Context, id string, in WebhookInput) (*Webhook, error) {
	var out struct {
		Webhook Webhook `json:"webhook"`
	}
	if err := c.do(ctx, http.MethodPatch, "/webhooks/"+esc(id), in, &out); err != nil {
		return nil, err
	}
	return &out.Webhook, nil
}

func (c *Client) DeleteWebhook(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/webhooks/"+esc(id), nil, nil)
}

func (c *Client) GetWebhookSecret(ctx context.Context, id string) (string, error) {
	var out struct {
		Secret string `json:"secret"`
	}
	err := c.do(ctx, http.MethodGet, "/webhooks/"+esc(id)+"/secret", nil, &out)
	return out.Secret, err
}

// ---- Log streams -----------------------------------------------------------------------------

func (c *Client) ListLogStreams(ctx context.Context, workspaceID string) (*WorkspaceLogStreams, error) {
	var out WorkspaceLogStreams
	if err := c.do(ctx, http.MethodGet, "/workspaces/"+esc(workspaceID)+"/log-streams", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// PutWorkspaceLogStream creates or replaces the workspace default log stream.
func (c *Client) PutWorkspaceLogStream(ctx context.Context, workspaceID string, in LogStreamInput) (*LogStream, error) {
	var out LogStream
	if err := c.do(ctx, http.MethodPut, "/workspaces/"+esc(workspaceID)+"/log-stream", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteWorkspaceLogStream(ctx context.Context, workspaceID string) error {
	return c.do(ctx, http.MethodDelete, "/workspaces/"+esc(workspaceID)+"/log-stream", nil, nil)
}

// GetServiceLogStream returns the service's override, or nil when it has none.
func (c *Client) GetServiceLogStream(ctx context.Context, serviceID string) (*LogStream, error) {
	var out struct {
		Override *LogStream `json:"override"`
	}
	if err := c.do(ctx, http.MethodGet, "/services/"+esc(serviceID)+"/log-stream", nil, &out); err != nil {
		return nil, err
	}
	return out.Override, nil
}

func (c *Client) PutServiceLogStream(ctx context.Context, serviceID string, in LogStreamInput) (*LogStream, error) {
	var out LogStream
	if err := c.do(ctx, http.MethodPut, "/services/"+esc(serviceID)+"/log-stream", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteServiceLogStream(ctx context.Context, serviceID string) error {
	return c.do(ctx, http.MethodDelete, "/services/"+esc(serviceID)+"/log-stream", nil, nil)
}
