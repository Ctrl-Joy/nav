package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Ctrl-Joy/nav/terraform-provider-nav/internal/client"
)

var (
	_ resource.Resource                = &logStreamResource{}
	_ resource.ResourceWithConfigure   = &logStreamResource{}
	_ resource.ResourceWithImportState = &logStreamResource{}
)

func newLogStreamResource() resource.Resource { return &logStreamResource{} }

type logStreamResource struct{ base }

type logStreamModel struct {
	ID          types.String `tfsdk:"id"`
	WorkspaceID types.String `tfsdk:"workspace_id"`
	ServiceID   types.String `tfsdk:"service_id"`
	Protocol    types.String `tfsdk:"protocol"`
	Endpoint    types.String `tfsdk:"endpoint"`
	Token       types.String `tfsdk:"token"`
	Enabled     types.Bool   `tfsdk:"enabled"`
}

func (r *logStreamResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_log_stream"
}

func (r *logStreamResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Forwards logs to an external syslog or HTTPS endpoint. Without `service_id` this is the workspace default stream; " +
			"with it, an override for one service. A workspace has at most one default stream and each service at most one override. Requires admin access.",
		Attributes: map[string]schema.Attribute{
			"id":           idAttribute(),
			"workspace_id": workspaceAttribute(),
			"service_id": schema.StringAttribute{
				MarkdownDescription: "Service to override the workspace default for. Changing it forces a new stream.",
				Optional:            true,
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"protocol": schema.StringAttribute{
				MarkdownDescription: "`syslog-tls`, `syslog-tcp` or `https`.",
				Required:            true,
				Validators:          []validator.String{stringvalidator.OneOf("syslog-tls", "syslog-tcp", "https")},
			},
			"endpoint": schema.StringAttribute{
				MarkdownDescription: "`host:port` for syslog protocols, or an `https://` URL.",
				Required:            true,
				Validators:          []validator.String{stringvalidator.LengthBetween(3, 2000)},
			},
			"token": schema.StringAttribute{
				MarkdownDescription: "Optional token sent with every log line (e.g. a provider's ingestion key). Write-only on the API side: NAV only reports whether one is set.",
				Optional:            true,
				Sensitive:           true,
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 1000)},
			},
			"enabled": schema.BoolAttribute{
				MarkdownDescription: "Defaults to `true`.",
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(true),
			},
		},
	}
}

func (r *logStreamResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.configure(req.ProviderData, &resp.Diagnostics)
}

func (m *logStreamModel) fromAPI(ls *client.LogStream) {
	m.ID = types.StringValue(ls.ID)
	if ls.WorkspaceID != "" {
		m.WorkspaceID = types.StringValue(ls.WorkspaceID)
	}
	m.ServiceID = strOrNull(ls.ServiceID)
	m.Protocol = types.StringValue(ls.Protocol)
	m.Endpoint = types.StringValue(ls.Endpoint)
	m.Enabled = types.BoolValue(ls.Enabled)
	if !ls.HasToken {
		m.Token = types.StringNull() // a removed token shows up as drift
	}
}

func (r *logStreamResource) put(ctx context.Context, m *logStreamModel, ws string) (*client.LogStream, error) {
	in := client.LogStreamInput{
		Protocol: m.Protocol.ValueString(),
		Endpoint: m.Endpoint.ValueString(),
		Token:    strPtr(m.Token),
		Enabled:  m.Enabled.ValueBool(),
	}
	if known(m.ServiceID) {
		return r.api().PutServiceLogStream(ctx, m.ServiceID.ValueString(), in)
	}
	return r.api().PutWorkspaceLogStream(ctx, ws, in)
}

func (r *logStreamResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan logStreamModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	ws := r.workspace(plan.WorkspaceID, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	ls, err := r.put(ctx, &plan, ws)
	if err != nil {
		apiError(&resp.Diagnostics, "create log stream", err)
		return
	}
	plan.WorkspaceID = types.StringValue(ws)
	plan.fromAPI(ls)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

// find returns the stream in the slot the resource manages, or nil.
func (r *logStreamResource) find(ctx context.Context, m *logStreamModel, ws string) (*client.LogStream, error) {
	if known(m.ServiceID) {
		ls, err := r.api().GetServiceLogStream(ctx, m.ServiceID.ValueString())
		if client.IsNotFound(err) { // the service is gone
			return nil, nil
		}
		return ls, err
	}
	all, err := r.api().ListLogStreams(ctx, ws)
	if err != nil {
		return nil, err
	}
	if all.Default != nil && all.Default.ID == m.ID.ValueString() {
		return all.Default, nil
	}
	// After an import service_id is not known yet: look among the overrides too.
	for i := range all.Overrides {
		if all.Overrides[i].ID == m.ID.ValueString() {
			return &all.Overrides[i], nil
		}
	}
	return nil, nil
}

func (r *logStreamResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state logStreamModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	ws := r.workspace(state.WorkspaceID, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	ls, err := r.find(ctx, &state, ws)
	if err != nil {
		apiError(&resp.Diagnostics, "read log stream", err)
		return
	}
	if ls == nil || (ls.ID != state.ID.ValueString() && !state.ID.IsNull()) {
		// Deleted, or replaced by a different stream outside Terraform.
		resp.State.RemoveResource(ctx)
		return
	}
	state.WorkspaceID = types.StringValue(ws)
	state.fromAPI(ls)
	resp.Diagnostics.Append(resp.State.Set(ctx, state)...)
}

func (r *logStreamResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state logStreamModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	ws := r.workspace(state.WorkspaceID, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	ls, err := r.put(ctx, &plan, ws)
	if err != nil {
		apiError(&resp.Diagnostics, "update log stream", err)
		return
	}
	plan.WorkspaceID = types.StringValue(ws)
	plan.fromAPI(ls)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *logStreamResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state logStreamModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var err error
	if known(state.ServiceID) {
		err = r.api().DeleteServiceLogStream(ctx, state.ServiceID.ValueString())
	} else {
		ws := r.workspace(state.WorkspaceID, &resp.Diagnostics)
		if resp.Diagnostics.HasError() {
			return
		}
		err = r.api().DeleteWorkspaceLogStream(ctx, ws)
	}
	if err != nil && !client.IsNotFound(err) {
		apiError(&resp.Diagnostics, "delete log stream", err)
	}
}

// ImportState accepts "<id>" or "<workspace_id>/<id>"; the stream is looked up
// among the workspace default and the service overrides. The token cannot be imported.
func (r *logStreamResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importWithWorkspace(ctx, r.data, req, resp)
}
