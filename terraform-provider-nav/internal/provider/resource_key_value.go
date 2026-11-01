package provider

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Ctrl-Joy/nav/terraform-provider-nav/internal/client"
)

var (
	_ resource.Resource                = &keyValueResource{}
	_ resource.ResourceWithConfigure   = &keyValueResource{}
	_ resource.ResourceWithImportState = &keyValueResource{}
)

var (
	keyValuePlans    = []string{"free", "starter", "standard", "pro", "pro-plus"}
	keyValuePolicies = []string{"allkeys-lru", "noeviction", "allkeys-lfu", "volatile-lru", "volatile-lfu", "allkeys-random", "volatile-random", "volatile-ttl"}
)

func newKeyValueResource() resource.Resource { return &keyValueResource{} }

type keyValueResource struct{ base }

type keyValueModel struct {
	ID                       types.String `tfsdk:"id"`
	WorkspaceID              types.String `tfsdk:"workspace_id"`
	EnvironmentID            types.String `tfsdk:"environment_id"`
	Name                     types.String `tfsdk:"name"`
	Plan                     types.String `tfsdk:"plan"`
	MaxmemoryPolicy          types.String `tfsdk:"maxmemory_policy"`
	IPAllowList              []cidrModel  `tfsdk:"ip_allow_list"`
	WaitForAvailable         types.Bool   `tfsdk:"wait_for_available"`
	Slug                     types.String `tfsdk:"slug"`
	Status                   types.String `tfsdk:"status"`
	Password                 types.String `tfsdk:"password"`
	InternalConnectionString types.String `tfsdk:"internal_connection_string"`
	ExternalConnectionString types.String `tfsdk:"external_connection_string"`
}

func (r *keyValueResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_key_value"
}

func (r *keyValueResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	stable := []planmodifier.String{stringplanmodifier.UseStateForUnknown()}
	resp.Schema = schema.Schema{
		MarkdownDescription: "A Redis-compatible Key Value instance. Connection details are sensitive and read from the credentials endpoint " +
			"(developer access or above) once the instance is available.",
		Attributes: map[string]schema.Attribute{
			"id":           idAttribute(),
			"workspace_id": workspaceAttribute(),
			"environment_id": schema.StringAttribute{
				MarkdownDescription: "Project environment the instance belongs to. Changing it forces a new instance.",
				Optional:            true,
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"name": schema.StringAttribute{
				MarkdownDescription: "Display name.",
				Required:            true,
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 64)},
			},
			"plan": schema.StringAttribute{
				MarkdownDescription: "`free`, `starter`, `standard`, `pro` or `pro-plus`. Defaults to `free`.",
				Optional:            true,
				Computed:            true,
				Default:             stringdefault.StaticString("free"),
				Validators:          []validator.String{stringvalidator.OneOf(keyValuePlans...)},
			},
			"maxmemory_policy": schema.StringAttribute{
				MarkdownDescription: "Eviction policy. Defaults to `allkeys-lru`.",
				Optional:            true,
				Computed:            true,
				Default:             stringdefault.StaticString("allkeys-lru"),
				Validators:          []validator.String{stringvalidator.OneOf(keyValuePolicies...)},
			},
			"ip_allow_list": ipAllowListAttribute("instance"),
			"wait_for_available": schema.BoolAttribute{
				MarkdownDescription: "Wait up to 15 minutes for the instance to become `available` after creation. Defaults to `true`.",
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(true),
			},
			"slug":                       computedStable("Internal host name on the private network.", false),
			"status":                     schema.StringAttribute{MarkdownDescription: "Instance status, e.g. `creating` or `available`.", Computed: true},
			"password":                   schema.StringAttribute{MarkdownDescription: "Password of the `default` user.", Computed: true, Sensitive: true, PlanModifiers: stable},
			"internal_connection_string": schema.StringAttribute{MarkdownDescription: "`redis://` URL for services on the private network.", Computed: true, Sensitive: true, PlanModifiers: stable},
			"external_connection_string": schema.StringAttribute{MarkdownDescription: "`redis://` URL for clients outside NAV; null unless `ip_allow_list` is set.", Computed: true, Sensitive: true},
		},
	}
}

func (r *keyValueResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.configure(req.ProviderData, &resp.Diagnostics)
}

func (m *keyValueModel) fromAPI(kv *client.KeyValue) {
	m.ID = types.StringValue(kv.ID)
	m.WorkspaceID = types.StringValue(kv.WorkspaceID)
	m.EnvironmentID = strOrNull(kv.EnvironmentID)
	m.Name = types.StringValue(kv.Name)
	m.Plan = types.StringValue(kv.Plan)
	m.MaxmemoryPolicy = types.StringValue(kv.MaxmemoryPolicy)
	m.IPAllowList = fromCIDRs(kv.IPAllowList, m.IPAllowList)
	m.Slug = types.StringValue(kv.Slug)
	m.Status = types.StringValue(kv.Status)
}

// readCredentials keeps earlier values while the instance is not available
// (the API returns null URLs then) and turns unknown ones into null.
func (r *keyValueResource) readCredentials(ctx context.Context, m *keyValueModel, diags *diagsT) {
	creds, err := r.api().GetKeyValueCredentials(ctx, m.ID.ValueString())
	if err != nil {
		if client.StatusCode(err) != 403 {
			apiError(diags, "read Key Value credentials", err)
			return
		}
		creds = &client.KeyValueCredentials{}
	}
	if creds.Password != "" {
		m.Password = types.StringValue(creds.Password)
	} else if m.Password.IsUnknown() {
		m.Password = types.StringNull()
	}
	if creds.InternalURL != nil {
		m.InternalConnectionString = types.StringValue(*creds.InternalURL)
	} else if m.InternalConnectionString.IsUnknown() {
		m.InternalConnectionString = types.StringNull()
	}
	if creds.ExternalURL != nil {
		m.ExternalConnectionString = types.StringValue(*creds.ExternalURL)
	} else if m.Status.ValueString() == "available" || m.ExternalConnectionString.IsUnknown() {
		// Available without an external URL means external access is off.
		m.ExternalConnectionString = types.StringNull()
	}
}

func (r *keyValueResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan keyValueModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	ws := r.workspace(plan.WorkspaceID, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	kv, err := r.api().CreateKeyValue(ctx, ws, client.CreateKeyValueInput{
		Name:            plan.Name.ValueString(),
		Plan:            strPtr(plan.Plan),
		MaxmemoryPolicy: strPtr(plan.MaxmemoryPolicy),
		IPAllowList:     toCIDRs(plan.IPAllowList),
		EnvironmentID:   strPtr(plan.EnvironmentID),
	})
	if err != nil {
		apiError(&resp.Diagnostics, "create Key Value instance", err)
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), kv.ID)...)

	if plan.WaitForAvailable.ValueBool() {
		id := kv.ID
		err = waitFor(ctx, provisionTimeout, pollInterval, func() (bool, error) {
			cur, err := r.api().GetKeyValue(ctx, id)
			if err != nil {
				return false, err
			}
			kv = cur
			switch cur.Status {
			case "available":
				return true, nil
			case "failed":
				return false, fmt.Errorf("key value instance %s failed to provision", id)
			}
			return false, nil
		})
		if err != nil {
			apiError(&resp.Diagnostics, "wait for the Key Value instance to become available", err)
			return
		}
	}

	plan.fromAPI(kv)
	r.readCredentials(ctx, &plan, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *keyValueResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state keyValueModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	kv, err := r.api().GetKeyValue(ctx, state.ID.ValueString())
	if client.IsNotFound(err) {
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		apiError(&resp.Diagnostics, "read Key Value instance", err)
		return
	}
	if kv.Status == "deleting" {
		resp.State.RemoveResource(ctx)
		return
	}
	state.fromAPI(kv)
	if state.WaitForAvailable.IsNull() { // after import
		state.WaitForAvailable = types.BoolValue(true)
	}
	r.readCredentials(ctx, &state, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, state)...)
}

func (r *keyValueResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state keyValueModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	in := client.UpdateKeyValueInput{}
	if !plan.Name.Equal(state.Name) {
		in.Name = strPtr(plan.Name)
	}
	if !plan.Plan.Equal(state.Plan) {
		in.Plan = strPtr(plan.Plan)
	}
	if !plan.MaxmemoryPolicy.Equal(state.MaxmemoryPolicy) {
		in.MaxmemoryPolicy = strPtr(plan.MaxmemoryPolicy)
	}
	if !cidrsEqual(plan.IPAllowList, state.IPAllowList) {
		list := toCIDRs(plan.IPAllowList)
		in.IPAllowList = &list
	}
	kv, err := r.api().UpdateKeyValue(ctx, state.ID.ValueString(), in)
	if err != nil {
		apiError(&resp.Diagnostics, "update Key Value instance", err)
		return
	}
	plan.fromAPI(kv)
	r.readCredentials(ctx, &plan, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *keyValueResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state keyValueModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.api().DeleteKeyValue(ctx, state.ID.ValueString()); err != nil && !client.IsNotFound(err) {
		apiError(&resp.Diagnostics, "delete Key Value instance", err)
	}
}

func (r *keyValueResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
