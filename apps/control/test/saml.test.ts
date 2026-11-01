// SAML service-provider checks against assertions signed with a throwaway IdP key generated here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SamlError, acsUrl, authnRequest, generateSpKeyPair, newRequestId, normalizeCert, parseIdpMetadata, responseInResponseTo, spEntityId, spMetadata,
  validateResponse, type IdpSettings, type SpSettings,
} from '../src/lib/saml.ts';
import { b64, createIdp, iso } from './helpers/idp.ts';

const ORG = 'org_test123';
const IDP_ENTITY = 'https://idp.example.test/saml';

const rogueKeys = await generateSpKeyPair('Rogue IdP');
const spKeys = await generateSpKeyPair('NAV SP');
const sp: SpSettings = { entityId: spEntityId(ORG), acsUrl: acsUrl(ORG), cert: spKeys.cert, key: spKeys.key };
const testIdp = await createIdp(IDP_ENTITY, sp);
const idpKeys = testIdp.keys;
const { assertionXml, responseXml, sign, signedAssertionResponse } = testIdp;
const idp: IdpSettings = { entityId: IDP_ENTITY, ssoUrl: 'https://idp.example.test/sso', certs: [normalizeCert(idpKeys.cert)], binding: 'redirect' };

async function rejects(samlResponse: string, requestId: string, code: string | RegExp) {
  await assert.rejects(validateResponse({ idp, sp, samlResponse, requestId }), (err: unknown) => {
    assert.ok(err instanceof SamlError, `expected SamlError, got ${err}`);
    if (typeof code === 'string') assert.equal(err.code, code, err.message);
    else assert.match(err.message, code);
    return true;
  });
}

test('accepts an assertion signed by the IdP and extracts the user', async () => {
  const rid = newRequestId();
  const user = await validateResponse({ idp, sp, samlResponse: signedAssertionResponse({ requestId: rid }), requestId: rid });
  assert.equal(user.email, 'ada@acme.test');
  assert.equal(user.nameId, 'ada@acme.test');
  assert.equal(user.firstName, 'Ada');
  assert.equal(user.sessionIndex, '_s1');
});

test('accepts a response signed at the Response level (assertion unsigned)', async () => {
  const rid = newRequestId();
  const o = { requestId: rid };
  const user = await validateResponse({ idp, sp, samlResponse: b64(sign(responseXml(o, assertionXml(o)), 'Response')), requestId: rid });
  assert.equal(user.email, 'ada@acme.test');
});

test('accepts a certificate rollover list where the second cert signed', async () => {
  const rid = newRequestId();
  const rolled = { ...idp, certs: [normalizeCert(rogueKeys.cert), normalizeCert(idpKeys.cert)] };
  const user = await validateResponse({ idp: rolled, sp, samlResponse: signedAssertionResponse({ requestId: rid }), requestId: rid });
  assert.equal(user.email, 'ada@acme.test');
});

test('rejects an unsigned response', async () => {
  const rid = newRequestId();
  const o = { requestId: rid };
  await rejects(b64(responseXml(o, assertionXml(o))), rid, /Invalid signature/);
});

test('rejects a tampered assertion (email changed after signing)', async () => {
  const rid = newRequestId();
  const xml = responseXml({ requestId: rid }, sign(assertionXml({ requestId: rid }), 'Assertion'));
  await rejects(b64(xml.replaceAll('ada@acme.test', 'mallory@acme.test')), rid, /Invalid signature/);
});

test('rejects a tampered response-level signature', async () => {
  const rid = newRequestId();
  const o = { requestId: rid };
  const xml = sign(responseXml(o, assertionXml(o)), 'Response');
  await rejects(b64(xml.replace('>Ada<', '>Eve<')), rid, /Invalid signature/);
});

test('rejects an assertion signed by a key that is not the configured IdP certificate', async () => {
  const rid = newRequestId();
  await rejects(signedAssertionResponse({ requestId: rid }, rogueKeys.key), rid, /Invalid signature/);
});

test('rejects an expired assertion (beyond clock skew)', async () => {
  const rid = newRequestId();
  await rejects(signedAssertionResponse({ requestId: rid, notBefore: iso(-60 * 60_000), notOnOrAfter: iso(-10 * 60_000) }), rid, /expired|no valid subject confirmation/i);
});

test('rejects an assertion that is not yet valid (beyond clock skew)', async () => {
  const rid = newRequestId();
  await rejects(signedAssertionResponse({ requestId: rid, notBefore: iso(10 * 60_000), notOnOrAfter: iso(20 * 60_000) }), rid, /not yet valid/);
});

test('tolerates small clock skew', async () => {
  const rid = newRequestId();
  const user = await validateResponse({ idp, sp, samlResponse: signedAssertionResponse({ requestId: rid, notBefore: iso(30_000) }), requestId: rid });
  assert.equal(user.email, 'ada@acme.test');
});

test('rejects the wrong audience', async () => {
  const rid = newRequestId();
  await rejects(signedAssertionResponse({ requestId: rid, audience: 'https://other-sp.example/metadata' }), rid, /audience/i);
});

test('rejects a response answering a different request (InResponseTo)', async () => {
  const rid = newRequestId();
  await rejects(signedAssertionResponse({ requestId: newRequestId() }), rid, 'bad_in_response_to');
});

test('rejects a subject confirmation answering a different request', async () => {
  const rid = newRequestId();
  await rejects(signedAssertionResponse({ requestId: rid, subjectInResponseTo: newRequestId() }), rid, /InResponseTo does not match/);
});

test('rejects an IdP-initiated (unsolicited) response with no InResponseTo', async () => {
  const rid = newRequestId();
  const xml = Buffer.from(signedAssertionResponse({ requestId: rid }), 'base64').toString('utf8').replace(/ InResponseTo="[^"]+"/, '');
  await rejects(b64(xml), rid, 'bad_in_response_to');
});

test('rejects the wrong Recipient', async () => {
  const rid = newRequestId();
  await rejects(signedAssertionResponse({ requestId: rid, recipient: 'https://evil.example/acs' }), rid, 'bad_recipient');
});

test('rejects the wrong Destination', async () => {
  const rid = newRequestId();
  await rejects(signedAssertionResponse({ requestId: rid, destination: 'https://evil.example/acs' }), rid, 'bad_destination');
});

test('rejects an assertion from a different issuer signed with the same key', async () => {
  const rid = newRequestId();
  await rejects(signedAssertionResponse({ requestId: rid, issuer: 'https://other-idp.example' }), rid, 'bad_issuer');
});

test('rejects signature wrapping: a second, unsigned assertion next to the signed one', async () => {
  const rid = newRequestId();
  const o = { requestId: rid };
  const evil = assertionXml({ ...o, email: 'mallory@acme.test' });
  const xml = responseXml(o, evil + sign(assertionXml(o), 'Assertion'));
  await rejects(b64(xml), rid, /multiple assertions/);
});

test('rejects signature wrapping: signed assertion moved into Extensions, forged one in its place', async () => {
  const rid = newRequestId();
  const o = { requestId: rid };
  const signed = sign(assertionXml(o), 'Assertion');
  const forged = assertionXml({ ...o, email: 'mallory@acme.test' });
  const xml = responseXml(o, `<samlp:Extensions>${signed}</samlp:Extensions>${forged}`);
  await rejects(b64(xml), rid, /Invalid signature/);
});

test('rejects a DOCTYPE (entity expansion)', async () => {
  const rid = newRequestId();
  const xml = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]>' + Buffer.from(signedAssertionResponse({ requestId: rid }), 'base64').toString('utf8');
  await rejects(b64(xml), rid, 'bad_xml');
});

test('reads InResponseTo from a response', () => {
  const rid = newRequestId();
  assert.equal(responseInResponseTo(signedAssertionResponse({ requestId: rid })), rid);
});

test('parses IdP metadata', () => {
  const body = idpKeys.cert.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const xml = `<?xml version="1.0"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${IDP_ENTITY}">
    <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
      <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${body}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
      <md:KeyDescriptor use="encryption"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${rogueKeys.cert.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
      <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.test/post"/>
      <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.test/redirect"/>
    </md:IDPSSODescriptor></md:EntityDescriptor>`;
  const parsed = parseIdpMetadata(xml);
  assert.equal(parsed.entityId, IDP_ENTITY);
  assert.equal(parsed.ssoUrl, 'https://idp.example.test/redirect');
  assert.equal(parsed.binding, 'redirect');
  assert.deepEqual(parsed.certs, [normalizeCert(idpKeys.cert)]);
  assert.throws(() => parseIdpMetadata(xml.replace('https://idp.example.test/redirect', 'http://idp.example.test/redirect').replace(/<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"[^>]+>/, '')), /HTTPS/);
});

test('builds a signed redirect AuthnRequest and SP metadata', async () => {
  const rid = newRequestId();
  const out = await authnRequest(idp, sp, rid, 'relay');
  assert.ok('redirect' in out);
  const url = new URL(out.redirect);
  assert.equal(url.origin + url.pathname, idp.ssoUrl);
  assert.ok(url.searchParams.get('SAMLRequest'));
  assert.ok(url.searchParams.get('Signature'), 'AuthnRequest is signed');
  assert.equal(url.searchParams.get('RelayState'), 'relay');
  const { inflateRawSync } = await import('node:zlib');
  const req = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString('utf8');
  assert.match(req, new RegExp(`ID="${rid}"`));
  assert.match(req, new RegExp(`AssertionConsumerServiceURL="${sp.acsUrl.replace(/[/.]/g, '\\$&')}"`));
  const md = spMetadata(sp);
  assert.match(md, /SPSSODescriptor/);
  assert.match(md, new RegExp(sp.entityId.replace(/[/.]/g, '\\$&')));
});
