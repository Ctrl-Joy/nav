package provider

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Ctrl-Joy/nav/terraform-provider-nav/internal/client"
)

// diagsT shortens signatures of helpers that append diagnostics.
type diagsT = diag.Diagnostics

// base is embedded by every resource and data source to receive the provider's client.
type base struct {
	data *navData
}

func (b *base) configure(providerData any, diags *diag.Diagnostics) {
	if providerData == nil { // the provider is not configured yet (e.g. during validation)
		return
	}
	d, ok := providerData.(*navData)
	if !ok {
		diags.AddError("Unexpected provider data", fmt.Sprintf("expected *navData, got %T; please report this issue", providerData))
		return
	}
	b.data = d
}

func (b *base) api() *client.Client { return b.data.client }

// workspace resolves a resource's workspace_id, falling back to the provider default.
func (b *base) workspace(v types.String, diags *diag.Diagnostics) string {
	if !v.IsNull() && !v.IsUnknown() && v.ValueString() != "" {
		return v.ValueString()
	}
	if b.data != nil && b.data.workspaceID != "" {
		return b.data.workspaceID
	}
	diags.AddError("Missing workspace",
		"Set workspace_id on the resource, or workspace_id / NAV_WORKSPACE on the provider.")
	return ""
}

// splitImportID accepts "<id>" or "<parent>/<id>".
func splitImportID(id string) (parent, child string) {
	if i := strings.LastIndex(id, "/"); i >= 0 {
		return id[:i], id[i+1:]
	}
	return "", id
}

func apiError(diags *diag.Diagnostics, action string, err error) {
	diags.AddError("NAV API error", fmt.Sprintf("Unable to %s: %s", action, err))
}

// ---- value conversion ------------------------------------------------------------

func strOrNull(p *string) types.String {
	if p == nil {
		return types.StringNull()
	}
	return types.StringValue(*p)
}

// strOrNullEmpty maps "" to null as well.
func strOrNullEmpty(s string) types.String {
	if s == "" {
		return types.StringNull()
	}
	return types.StringValue(s)
}

func int64OrNull(p *int64) types.Int64 {
	if p == nil {
		return types.Int64Null()
	}
	return types.Int64Value(*p)
}

// strPtr returns nil for a null or unknown value.
func strPtr(v types.String) *string {
	if v.IsNull() || v.IsUnknown() {
		return nil
	}
	s := v.ValueString()
	return &s
}

func int64Ptr(v types.Int64) *int64 {
	if v.IsNull() || v.IsUnknown() {
		return nil
	}
	n := v.ValueInt64()
	return &n
}

func known(v attr.Value) bool { return !v.IsNull() && !v.IsUnknown() }

// stringMap reads a map(string) attribute; null/unknown give nil.
func stringMap(ctx context.Context, m types.Map, diags *diag.Diagnostics) map[string]string {
	if !known(m) {
		return nil
	}
	out := map[string]string{}
	diags.Append(m.ElementsAs(ctx, &out, false)...)
	return out
}

func mapValue(ctx context.Context, in map[string]string, diags *diag.Diagnostics) types.Map {
	if in == nil {
		in = map[string]string{}
	}
	v, d := types.MapValueFrom(ctx, types.StringType, in)
	diags.Append(d...)
	return v
}

func stringSet(ctx context.Context, s types.Set, diags *diag.Diagnostics) []string {
	if !known(s) {
		return nil
	}
	var out []string
	diags.Append(s.ElementsAs(ctx, &out, false)...)
	sort.Strings(out)
	return out
}

func setValue(ctx context.Context, in []string, diags *diag.Diagnostics) types.Set {
	if in == nil {
		in = []string{}
	}
	v, d := types.SetValueFrom(ctx, types.StringType, in)
	diags.Append(d...)
	return v
}

func toEnvVars(m map[string]string) []client.EnvVar {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]client.EnvVar, 0, len(m))
	for _, k := range keys {
		out = append(out, client.EnvVar{Key: k, Value: m[k]})
	}
	return out
}

func fromEnvVars(vars []client.EnvVar) map[string]string {
	out := make(map[string]string, len(vars))
	for _, v := range vars {
		out[v.Key] = v.Value
	}
	return out
}

func toSecretFiles(m map[string]string) []client.SecretFile {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]client.SecretFile, 0, len(m))
	for _, k := range keys {
		out = append(out, client.SecretFile{Filename: k, Content: m[k]})
	}
	return out
}

func fromSecretFiles(files []client.SecretFile) map[string]string {
	out := make(map[string]string, len(files))
	for _, f := range files {
		out[f.Filename] = f.Content
	}
	return out
}

// ---- IP allow lists ----------------------------------------------------------------

type cidrModel struct {
	CIDR        types.String `tfsdk:"cidr"`
	Description types.String `tfsdk:"description"`
}

func ipAllowListAttribute(what string) schema.ListNestedAttribute {
	return schema.ListNestedAttribute{
		MarkdownDescription: "CIDR ranges allowed to reach the " + what + " from outside the private network. Leave unset (or empty) to block external access.",
		Optional:            true,
		NestedObject: schema.NestedAttributeObject{
			Attributes: map[string]schema.Attribute{
				"cidr": schema.StringAttribute{
					MarkdownDescription: "CIDR block, e.g. `203.0.113.0/24`.",
					Required:            true,
				},
				"description": schema.StringAttribute{
					MarkdownDescription: "Free-form note.",
					Optional:            true,
					Computed:            true,
					Default:             stringdefault.StaticString(""),
				},
			},
		},
	}
}

func toCIDRs(in []cidrModel) []client.CIDR {
	out := make([]client.CIDR, 0, len(in))
	for _, c := range in {
		out = append(out, client.CIDR{CIDR: c.CIDR.ValueString(), Description: c.Description.ValueString()})
	}
	return out
}

// fromCIDRs keeps an unset list unset when the API reports none.
func fromCIDRs(in []client.CIDR, prior []cidrModel) []cidrModel {
	if len(in) == 0 && prior == nil {
		return nil
	}
	out := make([]cidrModel, 0, len(in))
	for _, c := range in {
		out = append(out, cidrModel{CIDR: types.StringValue(c.CIDR), Description: types.StringValue(c.Description)})
	}
	return out
}

// ---- common attributes ------------------------------------------------------------

func idAttribute() schema.StringAttribute {
	return schema.StringAttribute{
		MarkdownDescription: "Identifier assigned by NAV.",
		Computed:            true,
		PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
	}
}

func workspaceAttribute() schema.StringAttribute {
	return schema.StringAttribute{
		MarkdownDescription: "Workspace that owns the resource. Defaults to the provider's `workspace_id`. Changing it forces a new resource.",
		Optional:            true,
		Computed:            true,
		PlanModifiers: []planmodifier.String{
			stringplanmodifier.UseStateForUnknown(),
			stringplanmodifier.RequiresReplace(),
		},
	}
}

// computedStable is a computed string that does not change once set.
func computedStable(desc string, sensitive bool) schema.StringAttribute {
	return schema.StringAttribute{
		MarkdownDescription: desc,
		Computed:            true,
		Sensitive:           sensitive,
		PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
	}
}

// ---- waiting ------------------------------------------------------------------------

// waitFor polls check every interval until it reports done, fails, or timeout passes.
func waitFor(ctx context.Context, timeout, interval time.Duration, check func() (bool, error)) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	for {
		done, err := check()
		if err != nil {
			return err
		}
		if done {
			return nil
		}
		t := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			t.Stop()
			return fmt.Errorf("timed out after %s", timeout)
		case <-t.C:
		}
	}
}

// cidrsEqual compares two allow lists by value.
func cidrsEqual(a, b []cidrModel) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if !a[i].CIDR.Equal(b[i].CIDR) || !a[i].Description.Equal(b[i].Description) {
			return false
		}
	}
	return true
}
