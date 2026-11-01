package provider

import (
	"context"
	"fmt"
	"regexp"

	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/setvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Ctrl-Joy/nav/terraform-provider-nav/internal/client"
)

var (
	_ resource.Resource                   = &serviceResource{}
	_ resource.ResourceWithConfigure      = &serviceResource{}
	_ resource.ResourceWithImportState    = &serviceResource{}
	_ resource.ResourceWithValidateConfig = &serviceResource{}
)

var (
	serviceTypes = []string{"web", "private", "worker", "cron", "static"}
	runtimes     = []string{"auto", "node", "python", "go", "ruby", "bun", "docker", "image", "static"}
	servicePlans = []string{"free", "starter", "standard", "pro", "pro_plus"}
	autoDeploys  = []string{"commit", "checks", "off"}
)

func newServiceResource() resource.Resource { return &serviceResource{} }

type serviceResource struct{ base }

type autoscalingModel struct {
	Enabled             types.Bool  `tfsdk:"enabled"`
	Min                 types.Int64 `tfsdk:"min"`
	Max                 types.Int64 `tfsdk:"max"`
	TargetCPUPercent    types.Int64 `tfsdk:"target_cpu_percent"`
	TargetMemoryPercent types.Int64 `tfsdk:"target_memory_percent"`
}

type diskModel struct {
	Name      types.String `tfsdk:"name"`
	MountPath types.String `tfsdk:"mount_path"`
	SizeGB    types.Int64  `tfsdk:"size_gb"`
}

type serviceModel struct {
	ID                   types.String      `tfsdk:"id"`
	WorkspaceID          types.String      `tfsdk:"workspace_id"`
	EnvironmentID        types.String      `tfsdk:"environment_id"`
	Name                 types.String      `tfsdk:"name"`
	Type                 types.String      `tfsdk:"type"`
	Runtime              types.String      `tfsdk:"runtime"`
	RepoURL              types.String      `tfsdk:"repo_url"`
	Branch               types.String      `tfsdk:"branch"`
	RootDir              types.String      `tfsdk:"root_dir"`
	ImageURL             types.String      `tfsdk:"image_url"`
	RegistryCredentialID types.String      `tfsdk:"registry_credential_id"`
	BuildCommand         types.String      `tfsdk:"build_command"`
	StartCommand         types.String      `tfsdk:"start_command"`
	PreDeployCommand     types.String      `tfsdk:"pre_deploy_command"`
	DockerfilePath       types.String      `tfsdk:"dockerfile_path"`
	DockerContext        types.String      `tfsdk:"docker_context"`
	PublishPath          types.String      `tfsdk:"publish_path"`
	HealthCheckPath      types.String      `tfsdk:"health_check_path"`
	Port                 types.Int64       `tfsdk:"port"`
	Plan                 types.String      `tfsdk:"plan"`
	InstanceCount        types.Int64       `tfsdk:"instance_count"`
	Autoscaling          *autoscalingModel `tfsdk:"autoscaling"`
	Disk                 *diskModel        `tfsdk:"disk"`
	AutoDeploy           types.String      `tfsdk:"auto_deploy"`
	CronSchedule         types.String      `tfsdk:"cron_schedule"`
	EnvVars              types.Map         `tfsdk:"env_vars"`
	SecretFiles          types.Map         `tfsdk:"secret_files"`
	EnvGroupIDs          types.Set         `tfsdk:"env_group_ids"`
	DeployOnEnvChange    types.Bool        `tfsdk:"deploy_on_env_change"`
	Slug                 types.String      `tfsdk:"slug"`
	URL                  types.String      `tfsdk:"url"`
	InternalAddress      types.String      `tfsdk:"internal_address"`
	Status               types.String      `tfsdk:"status"`
	DeployHookURL        types.String      `tfsdk:"deploy_hook_url"`
}

func (r *serviceResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_service"
}

func optionalCommand(desc string) schema.StringAttribute {
	return schema.StringAttribute{
		MarkdownDescription: desc,
		Optional:            true,
		Validators:          []validator.String{stringvalidator.LengthBetween(1, 4096)},
	}
}

func (r *serviceResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A NAV service: a web service, private service, background worker, cron job or static site. " +
			"Creating a service queues its first deploy. Settings changes apply on the next deploy; env var, secret file and env group " +
			"changes queue an `env_change` deploy unless `deploy_on_env_change` is `false`. Custom domains are managed with `nav_custom_domain`.",
		Attributes: map[string]schema.Attribute{
			"id":           idAttribute(),
			"workspace_id": workspaceAttribute(),
			"environment_id": schema.StringAttribute{
				MarkdownDescription: "Project environment the service belongs to (see `nav_project.environment_ids` / `nav_environment`).",
				Optional:            true,
			},
			"name": schema.StringAttribute{
				MarkdownDescription: "Service name (1-64 characters). The URL slug is derived from the name at creation and does not change when renaming.",
				Required:            true,
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 64)},
			},
			"type": schema.StringAttribute{
				MarkdownDescription: "One of `web`, `private`, `worker`, `cron`, `static`. Changing it forces a new service.",
				Required:            true,
				Validators:          []validator.String{stringvalidator.OneOf(serviceTypes...)},
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"runtime": schema.StringAttribute{
				MarkdownDescription: "Build runtime: `auto`, `node`, `python`, `go`, `ruby`, `bun`, `docker`, `image` or `static`. Defaults to `image` when `image_url` is set, otherwise `auto` (detected from the repository).",
				Optional:            true,
				Computed:            true,
				Validators:          []validator.String{stringvalidator.OneOf(runtimes...)},
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"repo_url": schema.StringAttribute{
				MarkdownDescription: "HTTPS URL of the Git repository, e.g. `https://github.com/acme/api`. Required unless `image_url` is set.",
				Optional:            true,
				Validators: []validator.String{
					stringvalidator.RegexMatches(regexp.MustCompile(`^https?://[^/@\s]+(/\S*[^/\s])?$`), "must be an http(s) URL without credentials or a trailing slash"),
				},
			},
			"branch": schema.StringAttribute{
				MarkdownDescription: "Branch to build. Defaults to the repository's default branch.",
				Optional:            true,
				Computed:            true,
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"root_dir": schema.StringAttribute{
				MarkdownDescription: "Directory inside the repository to build from (relative, no leading `./` or trailing `/`). Defaults to the repository root.",
				Optional:            true,
				Computed:            true,
				Default:             stringdefault.StaticString(""),
				Validators: []validator.String{
					stringvalidator.RegexMatches(regexp.MustCompile(`^$|^[^./\\][^\\]*[^/\\]$|^[^./\\]$`), "must be a relative path without a leading ./ or trailing /"),
				},
			},
			"image_url": schema.StringAttribute{
				MarkdownDescription: "Prebuilt container image to run instead of building a repository, e.g. `ghcr.io/acme/api:1.2.3`.",
				Optional:            true,
			},
			"registry_credential_id": schema.StringAttribute{
				MarkdownDescription: "`nav_registry_credential` used to pull `image_url` from a private registry.",
				Optional:            true,
			},
			"build_command":      optionalCommand("Build command, e.g. `npm ci && npm run build`."),
			"start_command":      optionalCommand("Start command, e.g. `npm start`. Required for cron jobs that do not run an image."),
			"pre_deploy_command": optionalCommand("Command run once before each deploy goes live, e.g. database migrations."),
			"dockerfile_path": schema.StringAttribute{
				MarkdownDescription: "Dockerfile path for the `docker` runtime. Defaults to `Dockerfile`.",
				Optional:            true,
				Computed:            true,
				Default:             stringdefault.StaticString("Dockerfile"),
			},
			"docker_context": schema.StringAttribute{
				MarkdownDescription: "Docker build context. Defaults to `.`.",
				Optional:            true,
				Computed:            true,
				Default:             stringdefault.StaticString("."),
			},
			"publish_path": schema.StringAttribute{
				MarkdownDescription: "Directory served by a static site, e.g. `dist`.",
				Optional:            true,
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 255)},
			},
			"health_check_path": schema.StringAttribute{
				MarkdownDescription: "HTTP path probed before a deploy goes live (web services only), e.g. `/healthz`.",
				Optional:            true,
				Validators: []validator.String{
					stringvalidator.RegexMatches(regexp.MustCompile(`^/`), "must start with /"),
				},
			},
			"port": schema.Int64Attribute{
				MarkdownDescription: "Port the service listens on (web and private services). NAV also injects `PORT`.",
				Optional:            true,
				Validators:          []validator.Int64{int64validator.Between(1, 65535)},
			},
			"plan": schema.StringAttribute{
				MarkdownDescription: "Instance plan: `free`, `starter`, `standard`, `pro` or `pro_plus`. Defaults to `starter` (`free` for static sites).",
				Optional:            true,
				Computed:            true,
				Validators:          []validator.String{stringvalidator.OneOf(servicePlans...)},
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"instance_count": schema.Int64Attribute{
				MarkdownDescription: "Number of instances (1-100). Defaults to 1. While autoscaling is enabled the live count is managed by NAV and drift is ignored.",
				Optional:            true,
				Computed:            true,
				Validators:          []validator.Int64{int64validator.Between(1, 100)},
				PlanModifiers:       []planmodifier.Int64{int64planmodifier.UseStateForUnknown()},
			},
			"autoscaling": schema.SingleNestedAttribute{
				MarkdownDescription: "Horizontal autoscaling. Unavailable on the `free` plan and for services with a disk.",
				Optional:            true,
				Attributes: map[string]schema.Attribute{
					"enabled": schema.BoolAttribute{
						MarkdownDescription: "Defaults to `true`.",
						Optional:            true,
						Computed:            true,
						Default:             booldefault.StaticBool(true),
					},
					"min": schema.Int64Attribute{
						MarkdownDescription: "Minimum instances (1-100).",
						Required:            true,
						Validators:          []validator.Int64{int64validator.Between(1, 100)},
					},
					"max": schema.Int64Attribute{
						MarkdownDescription: "Maximum instances (1-100), at least `min`.",
						Required:            true,
						Validators:          []validator.Int64{int64validator.Between(1, 100)},
					},
					"target_cpu_percent": schema.Int64Attribute{
						MarkdownDescription: "Target average CPU utilisation (10-95).",
						Optional:            true,
						Validators:          []validator.Int64{int64validator.Between(10, 95)},
					},
					"target_memory_percent": schema.Int64Attribute{
						MarkdownDescription: "Target average memory utilisation (10-95).",
						Optional:            true,
						Validators:          []validator.Int64{int64validator.Between(10, 95)},
					},
				},
			},
			"disk": schema.SingleNestedAttribute{
				MarkdownDescription: "Persistent disk. Limits the service to one instance and is unavailable on the `free` plan.",
				Optional:            true,
				Attributes: map[string]schema.Attribute{
					"name": schema.StringAttribute{
						MarkdownDescription: "Disk name.",
						Required:            true,
						Validators:          []validator.String{stringvalidator.LengthBetween(1, 64)},
					},
					"mount_path": schema.StringAttribute{
						MarkdownDescription: "Absolute mount path, e.g. `/var/data`.",
						Required:            true,
						Validators: []validator.String{
							stringvalidator.RegexMatches(regexp.MustCompile(`^/[A-Za-z0-9_./-]*$`), "must be an absolute path"),
						},
					},
					"size_gb": schema.Int64Attribute{
						MarkdownDescription: "Size in GB (1-1024).",
						Required:            true,
						Validators:          []validator.Int64{int64validator.Between(1, 1024)},
					},
				},
			},
			"auto_deploy": schema.StringAttribute{
				MarkdownDescription: "`commit` (deploy every push to `branch`), `checks` (only after the commit's checks pass) or `off`. Defaults to `commit`.",
				Optional:            true,
				Computed:            true,
				Default:             stringdefault.StaticString("commit"),
				Validators:          []validator.String{stringvalidator.OneOf(autoDeploys...)},
			},
			"cron_schedule": schema.StringAttribute{
				MarkdownDescription: "Cron expression (UTC). Required for, and only valid on, `cron` services.",
				Optional:            true,
			},
			"env_vars": schema.MapAttribute{
				MarkdownDescription: "Environment variables, as a map of name to value. When set, Terraform manages the full set and removes variables not listed; " +
					"when omitted, variables are left unmanaged. Values are sensitive.",
				ElementType: types.StringType,
				Optional:    true,
				Sensitive:   true,
			},
			"secret_files": schema.MapAttribute{
				MarkdownDescription: "Secret files, as a map of file name to content, mounted at `/etc/secrets/<name>`. Managed as a full set like `env_vars`. Contents are sensitive.",
				ElementType:         types.StringType,
				Optional:            true,
				Sensitive:           true,
			},
			"env_group_ids": schema.SetAttribute{
				MarkdownDescription: "IDs of `nav_env_group`s linked to the service. When omitted, links are left unmanaged.",
				ElementType:         types.StringType,
				Optional:            true,
				Validators:          []validator.Set{setvalidator.SizeAtMost(20)},
			},
			"deploy_on_env_change": schema.BoolAttribute{
				MarkdownDescription: "Queue a deploy when `env_vars` or `secret_files` change. Defaults to `true`.",
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(true),
			},
			"slug":             computedStable("URL-safe identifier derived from the name at creation.", false),
			"url":              computedStable("Public URL (web services and static sites).", false),
			"deploy_hook_url":  computedStable("Deploy hook URL; anyone holding it can trigger a deploy.", true),
			"internal_address": schema.StringAttribute{MarkdownDescription: "`host:port` on the private network (web and private services).", Computed: true},
			"status":           schema.StringAttribute{MarkdownDescription: "Current status: `created`, `deploying`, `live`, `failed`, `suspended` or `sleeping`.", Computed: true},
		},
	}
}

func (r *serviceResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.configure(req.ProviderData, &resp.Diagnostics)
}

// ValidateConfig catches combinations the API would reject or silently ignore.
func (r *serviceResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var typ, runtime, repo, image, cron, health, start types.String
	var count types.Int64
	for p, dst := range map[string]*types.String{"type": &typ, "runtime": &runtime, "repo_url": &repo, "image_url": &image, "cron_schedule": &cron, "health_check_path": &health, "start_command": &start} {
		resp.Diagnostics.Append(req.Config.GetAttribute(ctx, path.Root(p), dst)...)
	}
	resp.Diagnostics.Append(req.Config.GetAttribute(ctx, path.Root("instance_count"), &count)...)
	if resp.Diagnostics.HasError() || typ.IsUnknown() || typ.IsNull() {
		return
	}
	t := typ.ValueString()
	if t == "cron" && cron.IsNull() {
		resp.Diagnostics.AddAttributeError(path.Root("cron_schedule"), "Missing cron schedule", "cron_schedule is required for cron services.")
	}
	if t != "cron" && known(cron) {
		resp.Diagnostics.AddAttributeError(path.Root("cron_schedule"), "Invalid attribute", "cron_schedule is only valid for cron services.")
	}
	if t == "cron" && known(count) && count.ValueInt64() != 1 {
		resp.Diagnostics.AddAttributeError(path.Root("instance_count"), "Invalid attribute", "cron services always run a single instance.")
	}
	if t != "web" && known(health) {
		resp.Diagnostics.AddAttributeError(path.Root("health_check_path"), "Invalid attribute", "health_check_path is only used by web services.")
	}
	usesImage := (known(runtime) && runtime.ValueString() == "image") || (runtime.IsNull() && !image.IsNull())
	if usesImage && image.IsNull() {
		resp.Diagnostics.AddAttributeError(path.Root("image_url"), "Missing image", "image_url is required when runtime is \"image\".")
	}
	if !usesImage && !runtime.IsUnknown() && repo.IsNull() {
		resp.Diagnostics.AddAttributeError(path.Root("repo_url"), "Missing repository", "repo_url is required unless the service runs a prebuilt image (image_url).")
	}
	if t == "cron" && !usesImage && known(runtime) && runtime.ValueString() != "docker" && start.IsNull() {
		resp.Diagnostics.AddAttributeError(path.Root("start_command"), "Missing command", "cron jobs need start_command unless they run a Docker build or an image.")
	}
}

func (m *serviceModel) autoscalingInput() *client.Autoscaling {
	if m.Autoscaling == nil {
		return nil
	}
	a := m.Autoscaling
	return &client.Autoscaling{
		Enabled:             a.Enabled.IsNull() || a.Enabled.IsUnknown() || a.Enabled.ValueBool(),
		Min:                 a.Min.ValueInt64(),
		Max:                 a.Max.ValueInt64(),
		TargetCPUPercent:    int64Ptr(a.TargetCPUPercent),
		TargetMemoryPercent: int64Ptr(a.TargetMemoryPercent),
	}
}

func (m *serviceModel) diskInput() *client.Disk {
	if m.Disk == nil {
		return nil
	}
	return &client.Disk{Name: m.Disk.Name.ValueString(), MountPath: m.Disk.MountPath.ValueString(), SizeGB: m.Disk.SizeGB.ValueInt64()}
}

// fromAPI copies the API view into the model. Attributes that are "unmanaged
// when unset" (env vars, secret files, env groups, autoscaling) keep a null
// prior value null.
func (m *serviceModel) fromAPI(s *client.Service) {
	m.ID = types.StringValue(s.ID)
	m.WorkspaceID = types.StringValue(s.WorkspaceID)
	m.EnvironmentID = strOrNull(s.EnvironmentID)
	m.Name = types.StringValue(s.Name)
	m.Type = types.StringValue(s.Type)
	m.Runtime = types.StringValue(s.Runtime)
	m.RepoURL = strOrNull(s.RepoURL)
	m.Branch = strOrNull(s.Branch)
	m.RootDir = types.StringValue(s.RootDir)
	m.ImageURL = strOrNull(s.ImageURL)
	m.RegistryCredentialID = strOrNull(s.RegistryCredentialID)
	m.BuildCommand = strOrNull(s.BuildCommand)
	m.StartCommand = strOrNull(s.StartCommand)
	m.PreDeployCommand = strOrNull(s.PreDeployCommand)
	m.DockerfilePath = types.StringValue(s.DockerfilePath)
	m.DockerContext = types.StringValue(s.DockerContext)
	m.PublishPath = strOrNull(s.PublishPath)
	m.HealthCheckPath = strOrNull(s.HealthCheckPath)
	m.Port = int64OrNull(s.Port)
	m.Plan = types.StringValue(s.Plan)
	m.AutoDeploy = types.StringValue(s.AutoDeploy)
	m.CronSchedule = strOrNull(s.CronSchedule)

	scaling := s.Autoscaling != nil && s.Autoscaling.Enabled
	// While autoscaling is on, NAV moves instance_count itself: keep the configured value.
	if !scaling || m.InstanceCount.IsNull() || m.InstanceCount.IsUnknown() {
		m.InstanceCount = types.Int64Value(s.InstanceCount)
	}
	switch {
	case s.Autoscaling == nil || (!s.Autoscaling.Enabled && m.Autoscaling == nil):
		m.Autoscaling = nil
	default:
		m.Autoscaling = &autoscalingModel{
			Enabled:             types.BoolValue(s.Autoscaling.Enabled),
			Min:                 types.Int64Value(s.Autoscaling.Min),
			Max:                 types.Int64Value(s.Autoscaling.Max),
			TargetCPUPercent:    int64OrNull(s.Autoscaling.TargetCPUPercent),
			TargetMemoryPercent: int64OrNull(s.Autoscaling.TargetMemoryPercent),
		}
	}
	if s.Disk == nil {
		m.Disk = nil
	} else {
		m.Disk = &diskModel{Name: types.StringValue(s.Disk.Name), MountPath: types.StringValue(s.Disk.MountPath), SizeGB: types.Int64Value(s.Disk.SizeGB)}
	}

	m.Slug = types.StringValue(s.Slug)
	m.URL = strOrNull(s.URL)
	m.InternalAddress = strOrNull(s.InternalAddress)
	m.Status = types.StringValue(s.Status)
	m.DeployHookURL = types.StringValue(s.DeployHookURL)
}

// readEnv refreshes the managed env vars, secret files and env group links.
func (r *serviceResource) readEnv(ctx context.Context, m *serviceModel, diags *diagsT) {
	id := m.ID.ValueString()
	if !m.EnvVars.IsNull() {
		vars, err := r.api().GetServiceEnvVars(ctx, id)
		if err != nil {
			apiError(diags, "read service env vars", err)
			return
		}
		m.EnvVars = mapValue(ctx, fromEnvVars(vars), diags)
	}
	if !m.SecretFiles.IsNull() {
		files, err := r.api().GetServiceSecretFiles(ctx, id)
		if err != nil {
			apiError(diags, "read service secret files", err)
			return
		}
		m.SecretFiles = mapValue(ctx, fromSecretFiles(files), diags)
	}
	if !m.EnvGroupIDs.IsNull() {
		groups, err := r.api().GetServiceEnvGroups(ctx, id)
		if err != nil {
			apiError(diags, "read service env groups", err)
			return
		}
		ids := make([]string, 0, len(groups))
		for _, g := range groups {
			ids = append(ids, g.ID)
		}
		m.EnvGroupIDs = setValue(ctx, ids, diags)
	}
}

func (r *serviceResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan serviceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	ws := r.workspace(plan.WorkspaceID, &resp.Diagnostics)
	envVars := stringMap(ctx, plan.EnvVars, &resp.Diagnostics)
	files := stringMap(ctx, plan.SecretFiles, &resp.Diagnostics)
	groups := stringSet(ctx, plan.EnvGroupIDs, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}

	in := client.CreateServiceInput{
		Name:             plan.Name.ValueString(),
		Type:             plan.Type.ValueString(),
		EnvironmentID:    strPtr(plan.EnvironmentID),
		Runtime:          strPtr(plan.Runtime),
		RepoURL:          strPtr(plan.RepoURL),
		Branch:           strPtr(plan.Branch),
		RootDir:          strPtr(plan.RootDir),
		ImageURL:         strPtr(plan.ImageURL),
		BuildCommand:     strPtr(plan.BuildCommand),
		StartCommand:     strPtr(plan.StartCommand),
		PreDeployCommand: strPtr(plan.PreDeployCommand),
		DockerfilePath:   strPtr(plan.DockerfilePath),
		DockerContext:    strPtr(plan.DockerContext),
		PublishPath:      strPtr(plan.PublishPath),
		HealthCheckPath:  strPtr(plan.HealthCheckPath),
		Port:             int64Ptr(plan.Port),
		Plan:             strPtr(plan.Plan),
		InstanceCount:    int64Ptr(plan.InstanceCount),
		AutoDeploy:       strPtr(plan.AutoDeploy),
		CronSchedule:     strPtr(plan.CronSchedule),
		EnvVars:          toEnvVars(envVars),
		SecretFiles:      toSecretFiles(files),
		EnvGroupIDs:      groups,
		Disk:             plan.diskInput(),
	}
	svc, err := r.api().CreateService(ctx, ws, in)
	if err != nil {
		apiError(&resp.Diagnostics, "create service", err)
		return
	}
	// Save the ID right away so a failure below leaves a tainted resource instead of an orphan.
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), svc.ID)...)

	// Autoscaling and the registry credential are not part of the create body.
	if plan.Autoscaling != nil || known(plan.RegistryCredentialID) {
		upd := updateInputFrom(&plan)
		if svc, err = r.api().UpdateService(ctx, svc.ID, upd); err != nil {
			apiError(&resp.Diagnostics, "configure new service", err)
			return
		}
	}

	plan.fromAPI(svc)
	r.readEnv(ctx, &plan, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func updateInputFrom(plan *serviceModel) client.UpdateServiceInput {
	count := int64Ptr(plan.InstanceCount)
	if plan.Autoscaling != nil && (plan.Autoscaling.Enabled.IsNull() || plan.Autoscaling.Enabled.ValueBool()) {
		// The autoscaler owns the live instance count; sending ours would scale the service.
		count = nil
	}
	return client.UpdateServiceInput{
		Name:                 strPtr(plan.Name),
		EnvironmentID:        strPtr(plan.EnvironmentID),
		Runtime:              strPtr(plan.Runtime),
		RepoURL:              strPtr(plan.RepoURL),
		Branch:               strPtr(plan.Branch),
		RootDir:              strPtr(plan.RootDir),
		ImageURL:             strPtr(plan.ImageURL),
		BuildCommand:         strPtr(plan.BuildCommand),
		StartCommand:         strPtr(plan.StartCommand),
		PreDeployCommand:     strPtr(plan.PreDeployCommand),
		DockerfilePath:       strPtr(plan.DockerfilePath),
		DockerContext:        strPtr(plan.DockerContext),
		PublishPath:          strPtr(plan.PublishPath),
		HealthCheckPath:      strPtr(plan.HealthCheckPath),
		Port:                 int64Ptr(plan.Port),
		Plan:                 strPtr(plan.Plan),
		InstanceCount:        count,
		AutoDeploy:           strPtr(plan.AutoDeploy),
		CronSchedule:         strPtr(plan.CronSchedule),
		Disk:                 plan.diskInput(),
		Autoscaling:          plan.autoscalingInput(),
		RegistryCredentialID: strPtr(plan.RegistryCredentialID),
	}
}

func (r *serviceResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state serviceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	svc, err := r.api().GetService(ctx, state.ID.ValueString())
	if client.IsNotFound(err) {
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		apiError(&resp.Diagnostics, "read service", err)
		return
	}
	state.fromAPI(svc)
	if state.DeployOnEnvChange.IsNull() { // after import
		state.DeployOnEnvChange = types.BoolValue(true)
	}
	r.readEnv(ctx, &state, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, state)...)
}

func (r *serviceResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state serviceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	id := state.ID.ValueString()

	upd := updateInputFrom(&plan)
	if plan.Autoscaling == nil && state.Autoscaling != nil {
		// Removing the block turns autoscaling off.
		upd.Autoscaling = &client.Autoscaling{Enabled: false, Min: 1, Max: 1}
		if state.Autoscaling.Min.ValueInt64() > 0 {
			upd.Autoscaling.Min = state.Autoscaling.Min.ValueInt64()
			upd.Autoscaling.Max = state.Autoscaling.Max.ValueInt64()
		}
	}
	svc, err := r.api().UpdateService(ctx, id, upd)
	if err != nil {
		apiError(&resp.Diagnostics, "update service", err)
		return
	}

	deploy := plan.DeployOnEnvChange.IsNull() || plan.DeployOnEnvChange.IsUnknown() || plan.DeployOnEnvChange.ValueBool()
	if !plan.EnvVars.Equal(state.EnvVars) && !(plan.EnvVars.IsNull() && state.EnvVars.IsNull()) {
		// Dropping env_vars from the configuration clears them (null -> empty set).
		vars := stringMap(ctx, plan.EnvVars, &resp.Diagnostics)
		if resp.Diagnostics.HasError() {
			return
		}
		if err := r.api().SetServiceEnvVars(ctx, id, toEnvVars(vars), deploy); err != nil {
			apiError(&resp.Diagnostics, "update service env vars", err)
			return
		}
	}
	if !plan.SecretFiles.Equal(state.SecretFiles) && !(plan.SecretFiles.IsNull() && state.SecretFiles.IsNull()) {
		files := stringMap(ctx, plan.SecretFiles, &resp.Diagnostics)
		if resp.Diagnostics.HasError() {
			return
		}
		if err := r.api().SetServiceSecretFiles(ctx, id, toSecretFiles(files), deploy); err != nil {
			apiError(&resp.Diagnostics, "update service secret files", err)
			return
		}
	}
	if !plan.EnvGroupIDs.Equal(state.EnvGroupIDs) && !(plan.EnvGroupIDs.IsNull() && state.EnvGroupIDs.IsNull()) {
		groups := stringSet(ctx, plan.EnvGroupIDs, &resp.Diagnostics)
		if resp.Diagnostics.HasError() {
			return
		}
		if err := r.api().SetServiceEnvGroups(ctx, id, groups); err != nil {
			apiError(&resp.Diagnostics, "update service env groups", err)
			return
		}
	}

	plan.fromAPI(svc)
	r.readEnv(ctx, &plan, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *serviceResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state serviceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.api().DeleteService(ctx, state.ID.ValueString()); err != nil && !client.IsNotFound(err) {
		apiError(&resp.Diagnostics, fmt.Sprintf("delete service %s", state.ID.ValueString()), err)
	}
}

// ImportState takes the service ID. env_vars, secret_files and env_group_ids
// start unmanaged; add them to the configuration to adopt them.
func (r *serviceResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
