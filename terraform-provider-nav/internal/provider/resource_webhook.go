package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/setvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/setdefault"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Ctrl-Joy/nav/terraform-provider-nav/internal/client"
)

var (
	_ resource.Resource                = &webhookResource{}
	_ resource.ResourceWithConfigure   = &webhookResource{}
	_ resource.ResourceWithImportState = &webhookResource{}
)

// webhookEvents mirrors WEBHOOK_EVENTS in apps/control/src/http/routes/outboundWebhooks.ts.
var webhookEvents = []string{
	"deploy_live", "deploy_failed", "deploy_canceled", "deploy_waiting_for_checks", "deploy_skipped_checks_failed", "service_created",
	"service_deleted", "settings_updated", "env_updated", "plan_changed", "scaled", "autoscaled", "restarted", "suspended", "resumed",
	"instance_crashed", "cron_failed", "database_created", "database_available", "database_updated", "database_failed", "database_deleted",
	"database_restore_started", "database_restored", "domain_added", "domain_verified", "domain_removed", "certificate_issued",
	"env_group_created", "env_group_updated", "env_group_deleted", "blueprint_created", "blueprint_synced",
	"preview_environment_requested", "preview_environment_deleted", "project_created", "member_added",
}

func newWebhookResource() resource.Resource { return &webhookResource{} }

type webhookResource struct{ base }

type webhookModel struct {
	ID          types.String `tfsdk:"id"`
	WorkspaceID types.String `tfsdk:"workspace_id"`
	Name        types.String `tfsdk:"name"`
	URL         types.String `tfsdk:"url"`
	Events      types.Set    `tfsdk:"events"`
	Enabled     types.Bool   `tfsdk:"enabled"`
	Secret      types.String `tfsdk:"secret"`
}

func (r *webhookResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_webhook"
}

func (r *webhookResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A workspace webhook: NAV POSTs signed JSON (Standard Webhooks headers) to `url` for the selected events. Requires admin access.",
		Attributes: map[string]schema.Attribute{
			"id":           idAttribute(),
			"workspace_id": workspaceAttribute(),
			"name": schema.StringAttribute{
				MarkdownDescription: "Display name.",
				Required:            true,
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 80)},
			},
			"url": schema.StringAttribute{
				MarkdownDescription: "Public HTTPS endpoint that receives the events.",
				Required:            true,
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 2000)},
			},
			"events": schema.SetAttribute{
				MarkdownDescription: "Event types to deliver, e.g. `deploy_live`, `deploy_failed`. An empty set (the default) delivers every event.",
				ElementType:         types.StringType,
				Optional:            true,
				Computed:            true,
				Default:             setdefault.StaticValue(types.SetValueMust(types.StringType, []attr.Value{})),
				Validators: []validator.Set{
					setvalidator.ValueStringsAre(stringvalidator.OneOf(webhookEvents...)),
				},
			},
			"enabled": schema.BoolAttribute{
				MarkdownDescription: "Whether deliveries are sent. Defaults to `true`.",
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(true),
			},
			"secret": computedStable("Signing secret (`whsec_...`) used to verify deliveries.", true),
		},
	}
}

func (r *webhookResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.configure(req.ProviderData, &resp.Diagnostics)
}

func (r *webhookResource) apply(ctx context.Context, m *webhookModel, w *client.Webhook, diags *diagsT) {
	m.ID = types.StringValue(w.ID)
	m.WorkspaceID = types.StringValue(w.WorkspaceID)
	m.Name = types.StringValue(w.Name)
	m.URL = types.StringValue(w.URL)
	m.Events = setValue(ctx, w.Events, diags)
	m.Enabled = types.BoolValue(w.Enabled)
}

func (m *webhookModel) input(ctx context.Context, diags *diagsT) client.WebhookInput {
	events := stringSet(ctx, m.Events, diags)
	if events == nil {
		events = []string{}
	}
	enabled := m.Enabled.ValueBool()
	return client.WebhookInput{Name: strPtr(m.Name), URL: strPtr(m.URL), Events: &events, Enabled: &enabled}
}

func (r *webhookResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan webhookModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	ws := r.workspace(plan.WorkspaceID, &resp.Diagnostics)
	in := plan.input(ctx, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	w, secret, err := r.api().CreateWebhook(ctx, ws, in)
	if err != nil {
		apiError(&resp.Diagnostics, "create webhook", err)
		return
	}
	r.apply(ctx, &plan, w, &resp.Diagnostics)
	plan.Secret = types.StringValue(secret)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *webhookResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state webhookModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	ws := r.workspace(state.WorkspaceID, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	w, err := r.api().GetWebhook(ctx, ws, state.ID.ValueString())
	if client.IsNotFound(err) {
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		apiError(&resp.Diagnostics, "read webhook", err)
		return
	}
	r.apply(ctx, &state, w, &resp.Diagnostics)
	// The secret can be rotated outside Terraform; refresh it.
	secret, err := r.api().GetWebhookSecret(ctx, w.ID)
	if err != nil {
		apiError(&resp.Diagnostics, "read webhook secret", err)
		return
	}
	state.Secret = types.StringValue(secret)
	resp.Diagnostics.Append(resp.State.Set(ctx, state)...)
}

func (r *webhookResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state webhookModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	in := plan.input(ctx, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	w, err := r.api().UpdateWebhook(ctx, state.ID.ValueString(), in)
	if err != nil {
		apiError(&resp.Diagnostics, "update webhook", err)
		return
	}
	r.apply(ctx, &plan, w, &resp.Diagnostics)
	plan.Secret = state.Secret
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *webhookResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state webhookModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.api().DeleteWebhook(ctx, state.ID.ValueString()); err != nil && !client.IsNotFound(err) {
		apiError(&resp.Diagnostics, "delete webhook", err)
	}
}

// ImportState accepts "<id>" or "<workspace_id>/<id>".
func (r *webhookResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importWithWorkspace(ctx, r.data, req, resp)
}
