package provider

import (
	"context"
	"fmt"
	"regexp"
	"time"

	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Ctrl-Joy/nav/terraform-provider-nav/internal/client"
)

var (
	_ resource.Resource                = &postgresResource{}
	_ resource.ResourceWithConfigure   = &postgresResource{}
	_ resource.ResourceWithImportState = &postgresResource{}
)

var (
	databasePlans = []string{"free", "basic-256mb", "basic-1gb", "pro-4gb", "pro-8gb"}
	identRE       = regexp.MustCompile(`^[a-z_][a-z0-9_]{0,62}$`)
)

const (
	provisionTimeout = 15 * time.Minute
	pollInterval     = 5 * time.Second
)

func newPostgresResource() resource.Resource { return &postgresResource{} }

type postgresResource struct{ base }

type postgresModel struct {
	ID                       types.String `tfsdk:"id"`
	WorkspaceID              types.String `tfsdk:"workspace_id"`
	EnvironmentID            types.String `tfsdk:"environment_id"`
	Name                     types.String `tfsdk:"name"`
	Plan                     types.String `tfsdk:"plan"`
	PgVersion                types.Int64  `tfsdk:"pg_version"`
	DatabaseName             types.String `tfsdk:"database_name"`
	User                     types.String `tfsdk:"user"`
	DiskGB                   types.Int64  `tfsdk:"disk_gb"`
	IPAllowList              []cidrModel  `tfsdk:"ip_allow_list"`
	WaitForAvailable         types.Bool   `tfsdk:"wait_for_available"`
	Slug                     types.String `tfsdk:"slug"`
	Status                   types.String `tfsdk:"status"`
	Host                     types.String `tfsdk:"host"`
	Port                     types.Int64  `tfsdk:"port"`
	Password                 types.String `tfsdk:"password"`
	InternalConnectionString types.String `tfsdk:"internal_connection_string"`
	ExternalConnectionString types.String `tfsdk:"external_connection_string"`
}

func (r *postgresResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_postgres"
}

func (r *postgresResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	stable := []planmodifier.String{stringplanmodifier.UseStateForUnknown()}
	resp.Schema = schema.Schema{
		MarkdownDescription: "A managed PostgreSQL database. By default Terraform waits until the database is `available` and then reads its " +
			"connection details (sensitive) from the credentials endpoint, which needs developer access or above.",
		Attributes: map[string]schema.Attribute{
			"id":           idAttribute(),
			"workspace_id": workspaceAttribute(),
			"environment_id": schema.StringAttribute{
				MarkdownDescription: "Project environment the database belongs to. Changing it forces a new database.",
				Optional:            true,
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"name": schema.StringAttribute{
				MarkdownDescription: "Display name.",
				Required:            true,
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 64)},
			},
			"plan": schema.StringAttribute{
				MarkdownDescription: "`free`, `basic-256mb`, `basic-1gb`, `pro-4gb` or `pro-8gb`. Defaults to `basic-256mb`.",
				Optional:            true,
				Computed:            true,
				Default:             stringdefault.StaticString("basic-256mb"),
				Validators:          []validator.String{stringvalidator.OneOf(databasePlans...)},
			},
			"pg_version": schema.Int64Attribute{
				MarkdownDescription: "PostgreSQL major version (14-18). Defaults to 17. Changing it forces a new database.",
				Optional:            true,
				Computed:            true,
				Default:             int64default.StaticInt64(17),
				Validators:          []validator.Int64{int64validator.Between(14, 18)},
				PlanModifiers:       []planmodifier.Int64{int64planmodifier.RequiresReplace()},
			},
			"database_name": schema.StringAttribute{
				MarkdownDescription: "Name of the database inside the server. Derived from `name` when unset. Changing it forces a new database.",
				Optional:            true,
				Computed:            true,
				Validators:          []validator.String{stringvalidator.RegexMatches(identRE, "must be a lower-case identifier")},
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown(), stringplanmodifier.RequiresReplace()},
			},
			"user": schema.StringAttribute{
				MarkdownDescription: "Database user. Derived from `name` when unset; `postgres` and `nav` are reserved. Changing it forces a new database.",
				Optional:            true,
				Computed:            true,
				Validators: []validator.String{
					stringvalidator.RegexMatches(identRE, "must be a lower-case identifier"),
					stringvalidator.NoneOf("postgres", "nav"),
				},
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown(), stringplanmodifier.RequiresReplace()},
			},
			"disk_gb": schema.Int64Attribute{
				MarkdownDescription: "Disk size in GB (1-4096). Defaults to 1. Disks can only grow: lowering it forces a new database.",
				Optional:            true,
				Computed:            true,
				Default:             int64default.StaticInt64(1),
				Validators:          []validator.Int64{int64validator.Between(1, 4096)},
				PlanModifiers: []planmodifier.Int64{
					int64planmodifier.RequiresReplaceIf(func(_ context.Context, req planmodifier.Int64Request, resp *int64planmodifier.RequiresReplaceIfFuncResponse) {
						resp.RequiresReplace = known(req.StateValue) && known(req.PlanValue) && req.PlanValue.ValueInt64() < req.StateValue.ValueInt64()
					}, "Shrinking the disk forces a new database.", "Shrinking the disk forces a new database."),
				},
			},
			"ip_allow_list": ipAllowListAttribute("database (IPv4 CIDRs only)"),
			"wait_for_available": schema.BoolAttribute{
				MarkdownDescription: "Wait up to 15 minutes for the database to become `available` after creation. Defaults to `true`.",
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(true),
			},
			"slug":   computedStable("Internal host name on the private network.", false),
			"status": schema.StringAttribute{MarkdownDescription: "`creating`, `available`, `suspended`, `failed`, `restoring`.", Computed: true},
			"host":   schema.StringAttribute{MarkdownDescription: "Host of the database server.", Computed: true, PlanModifiers: stable},
			"port": schema.Int64Attribute{
				MarkdownDescription: "Port of the database server.",
				Computed:            true,
				PlanModifiers:       []planmodifier.Int64{int64planmodifier.UseStateForUnknown()},
			},
			"password":                   schema.StringAttribute{MarkdownDescription: "Database password.", Computed: true, Sensitive: true, PlanModifiers: stable},
			"internal_connection_string": schema.StringAttribute{MarkdownDescription: "`postgresql://` URL for services on the private network.", Computed: true, Sensitive: true, PlanModifiers: stable},
			"external_connection_string": schema.StringAttribute{MarkdownDescription: "`postgresql://` URL for clients outside NAV (requires `ip_allow_list`).", Computed: true, Sensitive: true, PlanModifiers: stable},
		},
	}
}

func (r *postgresResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.configure(req.ProviderData, &resp.Diagnostics)
}

func (m *postgresModel) fromAPI(db *client.Database) {
	m.ID = types.StringValue(db.ID)
	m.WorkspaceID = types.StringValue(db.WorkspaceID)
	m.EnvironmentID = strOrNull(db.EnvironmentID)
	m.Name = types.StringValue(db.Name)
	m.Plan = types.StringValue(db.Plan)
	m.PgVersion = types.Int64Value(db.PgVersion)
	m.DatabaseName = types.StringValue(db.DBName)
	m.User = types.StringValue(db.DBUser)
	m.DiskGB = types.Int64Value(db.DiskGB)
	m.IPAllowList = fromCIDRs(db.IPAllowList, m.IPAllowList)
	m.Slug = types.StringValue(db.Slug)
	m.Status = types.StringValue(db.Status)
}

// readCredentials fills the connection attributes. Until the database is
// available the API answers 409; earlier values are kept, unknown ones become null.
func (r *postgresResource) readCredentials(ctx context.Context, m *postgresModel, diags *diagsT) {
	creds, err := r.api().GetDatabaseCredentials(ctx, m.ID.ValueString())
	if err != nil {
		if code := client.StatusCode(err); code != 409 && code != 403 {
			apiError(diags, "read database credentials", err)
			return
		}
		creds = nil
	}
	set := func(dst *types.String, v string) {
		switch {
		case creds != nil:
			*dst = types.StringValue(v)
		case dst.IsUnknown():
			*dst = types.StringNull()
		}
	}
	var host, password, internal, external string
	if creds != nil {
		host, password, internal, external = creds.Host, creds.Password, creds.InternalURL, creds.ExternalURL
		m.Port = types.Int64Value(creds.Port)
	} else if m.Port.IsUnknown() {
		m.Port = types.Int64Null()
	}
	set(&m.Host, host)
	set(&m.Password, password)
	set(&m.InternalConnectionString, internal)
	set(&m.ExternalConnectionString, external)
}

func (r *postgresResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan postgresModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	ws := r.workspace(plan.WorkspaceID, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	db, err := r.api().CreateDatabase(ctx, ws, client.CreateDatabaseInput{
		Name:          plan.Name.ValueString(),
		Plan:          strPtr(plan.Plan),
		PgVersion:     int64Ptr(plan.PgVersion),
		DatabaseName:  strPtr(plan.DatabaseName),
		User:          strPtr(plan.User),
		EnvironmentID: strPtr(plan.EnvironmentID),
		DiskGB:        int64Ptr(plan.DiskGB),
	})
	if err != nil {
		apiError(&resp.Diagnostics, "create database", err)
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), db.ID)...)

	if len(plan.IPAllowList) > 0 { // not part of the create body
		list := toCIDRs(plan.IPAllowList)
		if db, err = r.api().UpdateDatabase(ctx, db.ID, client.UpdateDatabaseInput{IPAllowList: &list}); err != nil {
			apiError(&resp.Diagnostics, "set database IP allow list", err)
			return
		}
	}

	if plan.WaitForAvailable.ValueBool() {
		id := db.ID
		err = waitFor(ctx, provisionTimeout, pollInterval, func() (bool, error) {
			cur, err := r.api().GetDatabase(ctx, id)
			if err != nil {
				return false, err
			}
			db = cur
			switch cur.Status {
			case "available":
				return true, nil
			case "failed":
				return false, fmt.Errorf("database %s failed to provision; see its logs in the dashboard", id)
			}
			return false, nil
		})
		if err != nil {
			apiError(&resp.Diagnostics, "wait for the database to become available", err)
			return
		}
	}

	plan.fromAPI(db)
	r.readCredentials(ctx, &plan, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *postgresResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state postgresModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	db, err := r.api().GetDatabase(ctx, state.ID.ValueString())
	if client.IsNotFound(err) {
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		apiError(&resp.Diagnostics, "read database", err)
		return
	}
	state.fromAPI(db)
	if state.WaitForAvailable.IsNull() { // after import
		state.WaitForAvailable = types.BoolValue(true)
	}
	r.readCredentials(ctx, &state, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, state)...)
}

func (r *postgresResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state postgresModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	in := client.UpdateDatabaseInput{}
	if !plan.Name.Equal(state.Name) {
		in.Name = strPtr(plan.Name)
	}
	if !plan.Plan.Equal(state.Plan) {
		in.Plan = strPtr(plan.Plan)
	}
	if !plan.DiskGB.Equal(state.DiskGB) {
		in.DiskGB = int64Ptr(plan.DiskGB)
	}
	if !cidrsEqual(plan.IPAllowList, state.IPAllowList) {
		list := toCIDRs(plan.IPAllowList) // nil -> [] clears the list
		in.IPAllowList = &list
	}
	db, err := r.api().UpdateDatabase(ctx, state.ID.ValueString(), in)
	if err != nil {
		apiError(&resp.Diagnostics, "update database", err)
		return
	}
	// Keep the stable connection attributes from state.
	plan.Host, plan.Port, plan.Password = state.Host, state.Port, state.Password
	plan.InternalConnectionString, plan.ExternalConnectionString = state.InternalConnectionString, state.ExternalConnectionString
	plan.fromAPI(db)
	r.readCredentials(ctx, &plan, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *postgresResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state postgresModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.api().DeleteDatabase(ctx, state.ID.ValueString()); err != nil && !client.IsNotFound(err) {
		apiError(&resp.Diagnostics, "delete database", err)
	}
}

func (r *postgresResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
