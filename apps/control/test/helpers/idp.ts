// A throwaway SAML identity provider for tests: its own key pair, and builders for (signed) responses.
import { randomBytes } from 'node:crypto';
import { SignedXml } from 'xml-crypto';
import { generateSpKeyPair } from '../../src/lib/saml.ts';

export const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
export const b64 = (xml: string) => Buffer.from(xml, 'utf8').toString('base64');

export interface ResponseOpts {
  requestId: string;
  email?: string;
  nameId?: string;
  audience?: string;
  recipient?: string;
  destination?: string;
  issuer?: string;
  notBefore?: string;
  notOnOrAfter?: string;
  subjectInResponseTo?: string;
}

export async function createIdp(entityId: string, sp: { entityId: string; acsUrl: string }) {
  const keys = await generateSpKeyPair('Test IdP');

  const assertionXml = (o: ResponseOpts): string => {
    const id = `_a${randomBytes(8).toString('hex')}`;
    const nb = o.notBefore ?? iso(-60_000);
    const na = o.notOnOrAfter ?? iso(5 * 60_000);
    const email = o.email ?? 'ada@acme.test';
    return `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${iso(0)}">`
      + `<saml:Issuer>${o.issuer ?? entityId}</saml:Issuer>`
      + `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${o.nameId ?? email}</saml:NameID>`
      + `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${o.subjectInResponseTo ?? o.requestId}" NotOnOrAfter="${na}" Recipient="${o.recipient ?? sp.acsUrl}"/></saml:SubjectConfirmation></saml:Subject>`
      + `<saml:Conditions NotBefore="${nb}" NotOnOrAfter="${na}"><saml:AudienceRestriction><saml:Audience>${o.audience ?? sp.entityId}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`
      + `<saml:AuthnStatement AuthnInstant="${iso(0)}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`
      + `<saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute>`
      + `<saml:Attribute Name="firstName"><saml:AttributeValue>Ada</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>`
      + `</saml:Assertion>`;
  };

  const responseXml = (o: ResponseOpts, assertion: string): string =>
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomBytes(8).toString('hex')}" Version="2.0" IssueInstant="${iso(0)}" Destination="${o.destination ?? sp.acsUrl}" InResponseTo="${o.requestId}">`
    + `<saml:Issuer>${o.issuer ?? entityId}</saml:Issuer>`
    + `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>`
    + assertion
    + `</samlp:Response>`;

  /** Enveloped XML-DSig (RSA-SHA256, exclusive c14n) over the Assertion or the Response, placed after its Issuer. */
  const sign = (xml: string, element: 'Assertion' | 'Response', key = keys.key): string => {
    const sig = new SignedXml({ privateKey: key, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
    sig.addReference({
      xpath: `//*[local-name(.)='${element}']`,
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
      transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
    });
    sig.computeSignature(xml, { location: { reference: `//*[local-name(.)='${element}']/*[local-name(.)='Issuer']`, action: 'after' } });
    return sig.getSignedXml();
  };

  /** Base64 response whose assertion is signed (by the IdP key unless another is given). */
  const signedAssertionResponse = (o: ResponseOpts, key?: string): string => b64(responseXml(o, sign(assertionXml(o), 'Assertion', key)));

  const metadataXml = (ssoUrl: string): string => {
    const body = keys.cert.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    return `<?xml version="1.0"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${entityId}">`
      + `<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">`
      + `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${body}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`
      + `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${ssoUrl}"/>`
      + `</md:IDPSSODescriptor></md:EntityDescriptor>`;
  };

  return { entityId, keys, assertionXml, responseXml, sign, signedAssertionResponse, metadataXml };
}
