package provider

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Ctrl-Joy/nav/terraform-provider-nav/internal/client"
)

var (
	_ datasource.DataSourceWithConfigure = &workspaceDataSource{}
	_ datasource.DataSourceWithConfigure = &serviceDataSource{}
	_ datasource.DataSourceWithConfigure = &postgresDataSource{}
)

// dsWorkspace resolves a data source's workspace_id like base.workspace does for resources.
func dsWorkspace(b *base, v types.String, diags *diagsT) string { return b.workspace(v, diags) }

// ---- nav_workspace -------------------------------------------------------------------

func newWorkspaceDataSource() datasource.DataSource { return &workspaceDataSource{} }

type workspaceDataSource struct{ base }

type workspaceDSModel struct {
	ID        types.String `tfsdk:"id"`
	Name      types.String `tfsdk:"name"`
	Slug      types.String `tfsdk:"slug"`
	Role      types.String `tfsdk:"role"`
	CreatedAt types.String `tfsdk:"created_at"`
}

func (d *workspaceDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_workspace"
}

func (d *workspaceDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Looks up a workspace the API key can access, by `id`, `name` or `slug`. With none of them set, the provider's default workspace is returned.",
		Attributes: map[string]schema.Attribute{
			"id":         schema.StringAttribute{MarkdownDescription: "Workspace ID.", Optional: true, Computed: true},
			"name":       schema.StringAttribute{MarkdownDescription: "Workspace name.", Optional: true, Computed: true},
			"slug":       schema.StringAttribute{MarkdownDescription: "Workspace slug.", Optional: true, Computed: true},
			"role":       schema.StringAttribute{MarkdownDescription: "Your role: `owner`, `admin`, `developer` or `viewer`.", Computed: true},
			"created_at": schema.StringAttribute{MarkdownDescription: "Creation time (RFC 3339).", Computed: true},
		},
	}
}

func (d *workspaceDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	d.configure(req.ProviderData, &resp.Diagnostics)
}

func (d *workspaceDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var cfg workspaceDSModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() {
		return
	}
	list, err := d.api().ListWorkspaces(ctx)
	if err != nil {
		apiError(&resp.Diagnostics, "list workspaces", err)
		return
	}
	id := cfg.ID.ValueString()
	if id == "" && cfg.Name.IsNull() && cfg.Slug.IsNull() {
		id = d.data.workspaceID
		if id == "" {
			resp.Diagnostics.AddError("Missing workspace", "Set id, name or slug, or the provider's workspace_id.")
			return
		}
	}
	var found []client.Workspace
	for _, w := range list {
		if (id == "" || w.ID == id) && (cfg.Name.IsNull() || w.Name == cfg.Name.ValueString()) && (cfg.Slug.IsNull() || w.Slug == cfg.Slug.ValueString()) {
			found = append(found, w)
		}
	}
	if len(found) != 1 {
		resp.Diagnostics.AddError("Workspace not found", fmt.Sprintf("Expected exactly one matching workspace, found %d.", len(found)))
		return
	}
	w := found[0]
	cfg.ID, cfg.Name, cfg.Slug = types.StringValue(w.ID), types.StringValue(w.Name), types.StringValue(w.Slug)
	cfg.Role, cfg.CreatedAt = types.StringValue(w.Role), types.StringValue(w.CreatedAt)
	resp.Diagnostics.Append(resp.State.Set(ctx, cfg)...)
}

// ---- nav_service ----------------------------------------------------------------------

func newServiceDataSource() datasource.DataSource { return &serviceDataSource{} }

type serviceDataSource struct{ base }

type serviceDSModel struct {
	ID              types.String `tfsdk:"id"`
	WorkspaceID     types.String `tfsdk:"workspace_id"`
	Name            types.String `tfsdk:"name"`
	EnvironmentID   types.String `tfsdk:"environment_id"`
	Type            types.String `tfsdk:"type"`
	Runtime         types.String `tfsdk:"runtime"`
	RepoURL         types.String `tfsdk:"repo_url"`
	Branch          types.String `tfsdk:"branch"`
	ImageURL        types.String `tfsdk:"image_url"`
	Plan            types.String `tfsdk:"plan"`
	InstanceCount   types.Int64  `tfsdk:"instance_count"`
	Slug            types.String `tfsdk:"slug"`
	URL             types.String `tfsdk:"url"`
	InternalAddress types.String `tfsdk:"internal_address"`
	Status          types.String `tfsdk:"status"`
	Suspended       types.Bool   `tfsdk:"suspended"`
}

func (d *serviceDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_service"
}

func (d *serviceDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	c := func(desc string) schema.StringAttribute { return schema.StringAttribute{MarkdownDescription: desc, Computed: true} }
	resp.Schema = schema.Schema{
		MarkdownDescription: "Looks up a service by `id`, or by `name` within a workspace.",
		Attributes: map[string]schema.Attribute{
			"id":               schema.StringAttribute{MarkdownDescription: "Service ID. Set this or `name`.", Optional: true, Computed: true},
			"name":             schema.StringAttribute{MarkdownDescription: "Service name. Set this or `id`.", Optional: true, Computed: true},
			"workspace_id":     schema.StringAttribute{MarkdownDescription: "Workspace to search by name. Defaults to the provider's.", Optional: true, Computed: true},
			"environment_id":   c("Project environment, if any."),
			"type":             c("Service type."),
			"runtime":          c("Runtime."),
			"repo_url":         c("Repository URL."),
			"branch":           c("Branch."),
			"image_url":        c("Image, for image-backed services."),
			"plan":             c("Instance plan."),
			"instance_count":   schema.Int64Attribute{MarkdownDescription: "Instance count.", Computed: true},
			"slug":             c("Slug."),
			"url":              c("Public URL (web services and static sites)."),
			"internal_address": c("`host:port` on the private network."),
			"status":           c("Status."),
			"suspended":        schema.BoolAttribute{MarkdownDescription: "Whether the service is suspended.", Computed: true},
		},
	}
}

func (d *serviceDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	d.configure(req.ProviderData, &resp.Diagnostics)
}

func (d *serviceDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var cfg serviceDSModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var svc *client.Service
	switch {
	case known(cfg.ID):
		s, err := d.api().GetService(ctx, cfg.ID.ValueString())
		if err != nil {
			apiError(&resp.Diagnostics, "read service", err)
			return
		}
		svc = s
	case known(cfg.Name):
		ws := dsWorkspace(&d.base, cfg.WorkspaceID, &resp.Diagnostics)
		if resp.Diagnostics.HasError() {
			return
		}
		list, err := d.api().ListServices(ctx, ws)
		if err != nil {
			apiError(&resp.Diagnostics, "list services", err)
			return
		}
		var found []client.Service
		for _, s := range list {
			if s.Name == cfg.Name.ValueString() {
				found = append(found, s)
			}
		}
		if len(found) != 1 {
			resp.Diagnostics.AddError("Service not found", fmt.Sprintf("Expected exactly one service named %q, found %d.", cfg.Name.ValueString(), len(found)))
			return
		}
		svc = &found[0]
	default:
		resp.Diagnostics.AddError("Missing argument", "Set id or name.")
		return
	}
	cfg.ID, cfg.WorkspaceID, cfg.Name = types.StringValue(svc.ID), types.StringValue(svc.WorkspaceID), types.StringValue(svc.Name)
	cfg.EnvironmentID, cfg.Type, cfg.Runtime = strOrNull(svc.EnvironmentID), types.StringValue(svc.Type), types.StringValue(svc.Runtime)
	cfg.RepoURL, cfg.Branch, cfg.ImageURL = strOrNull(svc.RepoURL), strOrNull(svc.Branch), strOrNull(svc.ImageURL)
	cfg.Plan, cfg.InstanceCount, cfg.Slug = types.StringValue(svc.Plan), types.Int64Value(svc.InstanceCount), types.StringValue(svc.Slug)
	cfg.URL, cfg.InternalAddress = strOrNull(svc.URL), strOrNull(svc.InternalAddress)
	cfg.Status, cfg.Suspended = types.StringValue(svc.Status), types.BoolValue(svc.Suspended)
	resp.Diagnostics.Append(resp.State.Set(ctx, cfg)...)
}

// ---- nav_postgres --------------------------------------------------------------------

func newPostgresDataSource() datasource.DataSource { return &postgresDataSource{} }

type postgresDataSource struct{ base }

type postgresDSModel struct {
	ID                       types.String `tfsdk:"id"`
	WorkspaceID              types.String `tfsdk:"workspace_id"`
	Name                     types.String `tfsdk:"name"`
	Plan                     types.String `tfsdk:"plan"`
	PgVersion                types.Int64  `tfsdk:"pg_version"`
	Status                   types.String `tfsdk:"status"`
	Host                     types.String `tfsdk:"host"`
	Port                     types.Int64  `tfsdk:"port"`
	DatabaseName             types.String `tfsdk:"database_name"`
	User                     types.String `tfsdk:"user"`
	Password                 types.String `tfsdk:"password"`
	InternalConnectionString types.String `tfsdk:"internal_connection_string"`
	ExternalConnectionString types.String `tfsdk:"external_connection_string"`
	PsqlCommand              types.String `tfsdk:"psql_command"`
}

func (d *postgresDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_postgres"
}

func (d *postgresDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	sens := func(desc string) schema.StringAttribute {
		return schema.StringAttribute{MarkdownDescription: desc, Computed: true, Sensitive: true}
	}
	resp.Schema = schema.Schema{
		MarkdownDescription: "Looks up a PostgreSQL database by `id`, or by `name` within a workspace, including its connection details " +
			"(sensitive; from `GET /databases/:id/credentials`, which needs developer access and an available database).",
		Attributes: map[string]schema.Attribute{
			"id":                         schema.StringAttribute{MarkdownDescription: "Database ID. Set this or `name`.", Optional: true, Computed: true},
			"name":                       schema.StringAttribute{MarkdownDescription: "Database name. Set this or `id`.", Optional: true, Computed: true},
			"workspace_id":               schema.StringAttribute{MarkdownDescription: "Workspace to search by name. Defaults to the provider's.", Optional: true, Computed: true},
			"plan":                       schema.StringAttribute{MarkdownDescription: "Plan.", Computed: true},
			"pg_version":                 schema.Int64Attribute{MarkdownDescription: "PostgreSQL major version.", Computed: true},
			"status":                     schema.StringAttribute{MarkdownDescription: "Status.", Computed: true},
			"host":                       sens("Host."),
			"port":                       schema.Int64Attribute{MarkdownDescription: "Port.", Computed: true},
			"database_name":              schema.StringAttribute{MarkdownDescription: "Database name inside the server.", Computed: true},
			"user":                       schema.StringAttribute{MarkdownDescription: "Database user.", Computed: true},
			"password":                   sens("Password."),
			"internal_connection_string": sens("`postgresql://` URL for the private network."),
			"external_connection_string": sens("`postgresql://` URL for external clients."),
			"psql_command":               sens("Ready-to-run `psql` command."),
		},
	}
}

func (d *postgresDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	d.configure(req.ProviderData, &resp.Diagnostics)
}

func (d *postgresDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var cfg postgresDSModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var db *client.Database
	switch {
	case known(cfg.ID):
		v, err := d.api().GetDatabase(ctx, cfg.ID.ValueString())
		if err != nil {
			apiError(&resp.Diagnostics, "read database", err)
			return
		}
		db = v
	case known(cfg.Name):
		ws := dsWorkspace(&d.base, cfg.WorkspaceID, &resp.Diagnostics)
		if resp.Diagnostics.HasError() {
			return
		}
		list, err := d.api().ListDatabases(ctx, ws)
		if err != nil {
			apiError(&resp.Diagnostics, "list databases", err)
			return
		}
		var found []client.Database
		for _, v := range list {
			if v.Name == cfg.Name.ValueString() {
				found = append(found, v)
			}
		}
		if len(found) != 1 {
			resp.Diagnostics.AddError("Database not found", fmt.Sprintf("Expected exactly one database named %q, found %d.", cfg.Name.ValueString(), len(found)))
			return
		}
		db = &found[0]
	default:
		resp.Diagnostics.AddError("Missing argument", "Set id or name.")
		return
	}
	creds, err := d.api().GetDatabaseCredentials(ctx, db.ID)
	if err != nil {
		apiError(&resp.Diagnostics, "read database credentials (needs developer access and an available database)", err)
		return
	}
	cfg.ID, cfg.WorkspaceID, cfg.Name = types.StringValue(db.ID), types.StringValue(db.WorkspaceID), types.StringValue(db.Name)
	cfg.Plan, cfg.PgVersion, cfg.Status = types.StringValue(db.Plan), types.Int64Value(db.PgVersion), types.StringValue(db.Status)
	cfg.Host, cfg.Port = types.StringValue(creds.Host), types.Int64Value(creds.Port)
	cfg.DatabaseName, cfg.User, cfg.Password = types.StringValue(creds.Database), types.StringValue(creds.User), types.StringValue(creds.Password)
	cfg.InternalConnectionString, cfg.ExternalConnectionString = types.StringValue(creds.InternalURL), types.StringValue(creds.ExternalURL)
	cfg.PsqlCommand = types.StringValue(creds.PsqlCommand)
	resp.Diagnostics.Append(resp.State.Set(ctx, cfg)...)
}
