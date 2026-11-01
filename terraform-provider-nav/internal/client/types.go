package client

// Wire types mirror packages/shared/src/index.ts in the NAV repository
// (JSON, camelCase keys). Only fields the provider uses are declared.

type Workspace struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Slug      string `json:"slug"`
	Role      string `json:"role"`
	CreatedAt string `json:"createdAt"`
}

type Environment struct {
	ID        string `json:"id"`
	ProjectID string `json:"projectId"`
	Name      string `json:"name"`
	Protected bool   `json:"protected"`
}

type Project struct {
	ID           string        `json:"id"`
	WorkspaceID  string        `json:"workspaceId"`
	Name         string        `json:"name"`
	Environments []Environment `json:"environments"`
	CreatedAt    string        `json:"createdAt"`
}

type Autoscaling struct {
	Enabled             bool   `json:"enabled"`
	Min                 int64  `json:"min"`
	Max                 int64  `json:"max"`
	TargetCPUPercent    *int64 `json:"targetCpuPercent"`
	TargetMemoryPercent *int64 `json:"targetMemoryPercent"`
}

type Disk struct {
	Name      string `json:"name"`
	MountPath string `json:"mountPath"`
	SizeGB    int64  `json:"sizeGB"`
}

type Service struct {
	ID                   string       `json:"id"`
	WorkspaceID          string       `json:"workspaceId"`
	EnvironmentID        *string      `json:"environmentId"`
	Name                 string       `json:"name"`
	Slug                 string       `json:"slug"`
	Type                 string       `json:"type"`
	Runtime              string       `json:"runtime"`
	RepoURL              *string      `json:"repoUrl"`
	Branch               *string      `json:"branch"`
	RootDir              string       `json:"rootDir"`
	ImageURL             *string      `json:"imageUrl"`
	BuildCommand         *string      `json:"buildCommand"`
	StartCommand         *string      `json:"startCommand"`
	PreDeployCommand     *string      `json:"preDeployCommand"`
	DockerfilePath       string       `json:"dockerfilePath"`
	DockerContext        string       `json:"dockerContext"`
	PublishPath          *string      `json:"publishPath"`
	HealthCheckPath      *string      `json:"healthCheckPath"`
	Port                 *int64       `json:"port"`
	Plan                 string       `json:"plan"`
	InstanceCount        int64        `json:"instanceCount"`
	Autoscaling          *Autoscaling `json:"autoscaling"`
	AutoDeploy           string       `json:"autoDeploy"`
	CronSchedule         *string      `json:"cronSchedule"`
	Disk                 *Disk        `json:"disk"`
	ParentServiceID      *string      `json:"parentServiceId"`
	Suspended            bool         `json:"suspended"`
	RegistryCredentialID *string      `json:"registryCredentialId"`
	Status               string       `json:"status"`
	CurrentDeployID      *string      `json:"currentDeployId"`
	URL                  *string      `json:"url"`
	InternalAddress      *string      `json:"internalAddress"`
	DeployHookURL        string       `json:"deployHookUrl"`
	CreatedAt            string       `json:"createdAt"`
	UpdatedAt            string       `json:"updatedAt"`
}

type EnvVar struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type SecretFile struct {
	Filename string `json:"filename"`
	Content  string `json:"content"`
}

// CreateServiceInput is the body of POST /workspaces/:ws/services.
type CreateServiceInput struct {
	Name             string       `json:"name"`
	Type             string       `json:"type"`
	EnvironmentID    *string      `json:"environmentId,omitempty"`
	Runtime          *string      `json:"runtime,omitempty"`
	RepoURL          *string      `json:"repoUrl,omitempty"`
	Branch           *string      `json:"branch,omitempty"`
	RootDir          *string      `json:"rootDir,omitempty"`
	ImageURL         *string      `json:"imageUrl,omitempty"`
	BuildCommand     *string      `json:"buildCommand,omitempty"`
	StartCommand     *string      `json:"startCommand,omitempty"`
	PreDeployCommand *string      `json:"preDeployCommand,omitempty"`
	DockerfilePath   *string      `json:"dockerfilePath,omitempty"`
	DockerContext    *string      `json:"dockerContext,omitempty"`
	PublishPath      *string      `json:"publishPath,omitempty"`
	HealthCheckPath  *string      `json:"healthCheckPath,omitempty"`
	Port             *int64       `json:"port,omitempty"`
	Plan             *string      `json:"plan,omitempty"`
	InstanceCount    *int64       `json:"instanceCount,omitempty"`
	AutoDeploy       *string      `json:"autoDeploy,omitempty"`
	CronSchedule     *string      `json:"cronSchedule,omitempty"`
	EnvVars          []EnvVar     `json:"envVars,omitempty"`
	SecretFiles      []SecretFile `json:"secretFiles,omitempty"`
	EnvGroupIDs      []string     `json:"envGroupIds,omitempty"`
	Disk             *Disk        `json:"disk,omitempty"`
}

// UpdateServiceInput is the body of PATCH /services/:id. Fields without
// omitempty are always sent, so a nil pointer clears the value on the server.
type UpdateServiceInput struct {
	Name                 *string      `json:"name,omitempty"`
	EnvironmentID        *string      `json:"environmentId"`
	Runtime              *string      `json:"runtime,omitempty"`
	RepoURL              *string      `json:"repoUrl"`
	Branch               *string      `json:"branch,omitempty"`
	RootDir              *string      `json:"rootDir,omitempty"`
	ImageURL             *string      `json:"imageUrl"`
	BuildCommand         *string      `json:"buildCommand"`
	StartCommand         *string      `json:"startCommand"`
	PreDeployCommand     *string      `json:"preDeployCommand"`
	DockerfilePath       *string      `json:"dockerfilePath,omitempty"`
	DockerContext        *string      `json:"dockerContext,omitempty"`
	PublishPath          *string      `json:"publishPath"`
	HealthCheckPath      *string      `json:"healthCheckPath"`
	Port                 *int64       `json:"port"`
	Plan                 *string      `json:"plan,omitempty"`
	InstanceCount        *int64       `json:"instanceCount,omitempty"`
	AutoDeploy           *string      `json:"autoDeploy,omitempty"`
	CronSchedule         *string      `json:"cronSchedule"`
	Disk                 *Disk        `json:"disk"`
	Autoscaling          *Autoscaling `json:"autoscaling,omitempty"`
	RegistryCredentialID *string      `json:"registryCredentialId"`
}

type EnvGroupRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type CustomDomain struct {
	ID                 string  `json:"id"`
	ServiceID          string  `json:"serviceId"`
	Domain             string  `json:"domain"`
	RedirectTo         *string `json:"redirectTo"`
	VerificationStatus string  `json:"verificationStatus"`
	CertStatus         string  `json:"certStatus"`
	LastError          *string `json:"lastError"`
	DNSTarget          string  `json:"dnsTarget"`
	DNSRecordType      string  `json:"dnsRecordType"`
	VerifiedAt         *string `json:"verifiedAt"`
	CreatedAt          string  `json:"createdAt"`
}

type EnvGroup struct {
	ID          string       `json:"id"`
	WorkspaceID string       `json:"workspaceId"`
	Name        string       `json:"name"`
	EnvVars     []EnvVar     `json:"envVars"`
	SecretFiles []SecretFile `json:"secretFiles"`
	ServiceIDs  []string     `json:"serviceIds"`
	CreatedAt   string       `json:"createdAt"`
	UpdatedAt   string       `json:"updatedAt"`
}

type CreateEnvGroupInput struct {
	Name        string       `json:"name"`
	EnvVars     []EnvVar     `json:"envVars,omitempty"`
	SecretFiles []SecretFile `json:"secretFiles,omitempty"`
}

// UpdateEnvGroupInput: a nil slice pointer leaves that list unchanged, a
// pointer to an empty slice clears it.
type UpdateEnvGroupInput struct {
	Name        *string       `json:"name,omitempty"`
	EnvVars     *[]EnvVar     `json:"envVars,omitempty"`
	SecretFiles *[]SecretFile `json:"secretFiles,omitempty"`
}

type CIDR struct {
	CIDR        string `json:"cidr"`
	Description string `json:"description"`
}

type Database struct {
	ID            string  `json:"id"`
	WorkspaceID   string  `json:"workspaceId"`
	EnvironmentID *string `json:"environmentId"`
	Name          string  `json:"name"`
	Slug          string  `json:"slug"`
	Plan          string  `json:"plan"`
	PgVersion     int64   `json:"pgVersion"`
	DBName        string  `json:"dbName"`
	DBUser        string  `json:"dbUser"`
	DiskGB        int64   `json:"diskGB"`
	Status        string  `json:"status"`
	IPAllowList   []CIDR  `json:"ipAllowList"`
	CreatedAt     string  `json:"createdAt"`
}

type CreateDatabaseInput struct {
	Name          string  `json:"name"`
	Plan          *string `json:"plan,omitempty"`
	PgVersion     *int64  `json:"pgVersion,omitempty"`
	DatabaseName  *string `json:"databaseName,omitempty"`
	User          *string `json:"user,omitempty"`
	EnvironmentID *string `json:"environmentId,omitempty"`
	DiskGB        *int64  `json:"diskGB,omitempty"`
}

type UpdateDatabaseInput struct {
	Name        *string `json:"name,omitempty"`
	Plan        *string `json:"plan,omitempty"`
	IPAllowList *[]CIDR `json:"ipAllowList,omitempty"`
	DiskGB      *int64  `json:"diskGB,omitempty"`
}

type DatabaseCredentials struct {
	Host        string `json:"host"`
	Port        int64  `json:"port"`
	Database    string `json:"database"`
	User        string `json:"user"`
	Password    string `json:"password"`
	InternalURL string `json:"internalUrl"`
	ExternalURL string `json:"externalUrl"`
	PsqlCommand string `json:"psqlCommand"`
}

type KeyValue struct {
	ID              string  `json:"id"`
	WorkspaceID     string  `json:"workspaceId"`
	EnvironmentID   *string `json:"environmentId"`
	Name            string  `json:"name"`
	Slug            string  `json:"slug"`
	Plan            string  `json:"plan"`
	MaxmemoryPolicy string  `json:"maxmemoryPolicy"`
	Status          string  `json:"status"`
	IPAllowList     []CIDR  `json:"ipAllowList"`
	InternalURL     *string `json:"internalUrl"`
	ExternalURL     *string `json:"externalUrl"`
	CreatedAt       string  `json:"createdAt"`
	UpdatedAt       string  `json:"updatedAt"`
}

type CreateKeyValueInput struct {
	Name            string  `json:"name"`
	Plan            *string `json:"plan,omitempty"`
	MaxmemoryPolicy *string `json:"maxmemoryPolicy,omitempty"`
	IPAllowList     []CIDR  `json:"ipAllowList,omitempty"`
	EnvironmentID   *string `json:"environmentId,omitempty"`
}

type UpdateKeyValueInput struct {
	Name            *string `json:"name,omitempty"`
	Plan            *string `json:"plan,omitempty"`
	MaxmemoryPolicy *string `json:"maxmemoryPolicy,omitempty"`
	IPAllowList     *[]CIDR `json:"ipAllowList,omitempty"`
}

type KeyValueCredentials struct {
	Password    string  `json:"password"`
	InternalURL *string `json:"internalUrl"`
	ExternalURL *string `json:"externalUrl"`
}

type RegistryCredential struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspaceId"`
	Name        string `json:"name"`
	Registry    string `json:"registry"`
	Username    string `json:"username"`
	CreatedAt   string `json:"createdAt"`
}

type RegistryCredentialInput struct {
	Name     *string `json:"name,omitempty"`
	Registry *string `json:"registry,omitempty"`
	Username *string `json:"username,omitempty"`
	Password *string `json:"password,omitempty"`
}

type Webhook struct {
	ID          string   `json:"id"`
	WorkspaceID string   `json:"workspaceId"`
	Name        string   `json:"name"`
	URL         string   `json:"url"`
	Events      []string `json:"events"`
	Enabled     bool     `json:"enabled"`
	CreatedAt   string   `json:"createdAt"`
}

type WebhookInput struct {
	Name    *string   `json:"name,omitempty"`
	URL     *string   `json:"url,omitempty"`
	Events  *[]string `json:"events,omitempty"`
	Enabled *bool     `json:"enabled,omitempty"`
}

type LogStream struct {
	ID          string  `json:"id"`
	WorkspaceID string  `json:"workspaceId"`
	ServiceID   *string `json:"serviceId"`
	Protocol    string  `json:"protocol"`
	Endpoint    string  `json:"endpoint"`
	HasToken    bool    `json:"hasToken"`
	Enabled     bool    `json:"enabled"`
	LastError   *string `json:"lastError"`
	LastSentAt  *string `json:"lastSentAt"`
	CreatedAt   string  `json:"createdAt"`
}

// LogStreamInput is the body of PUT .../log-stream. Token is always sent: nil
// removes a stored token.
type LogStreamInput struct {
	Protocol string  `json:"protocol"`
	Endpoint string  `json:"endpoint"`
	Token    *string `json:"token"`
	Enabled  bool    `json:"enabled"`
}

type WorkspaceLogStreams struct {
	Default   *LogStream  `json:"default"`
	Overrides []LogStream `json:"overrides"`
}
