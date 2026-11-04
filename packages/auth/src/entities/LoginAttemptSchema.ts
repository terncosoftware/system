import {
    attemptUserIRI,
    authRedirectUrlIRI,
    claimIRI,
    errorCodeIRI,
    ipAddressIRI,
    LoginAttemptIRI,
    nonceIRI,
    providerIRI,
    statusIRI,
    userAgentIRI,
    utmCampaignIRI,
    utmMediumIRI,
    utmSourceIRI,
} from "@terncosoftware/core";
import { EntitySchema } from "@terncosoftware/entities";
import { AUTH_NS } from "../constants.js";

export const LoginAttemptSchema = new EntitySchema({
    typeIRI: LoginAttemptIRI,
    ns: AUTH_NS,
    properties: {
        provider: providerIRI,
        status: statusIRI,
        nonce: nonceIRI,
        errorCode: errorCodeIRI,
        ipAddress: { iri: ipAddressIRI, pii: true },
        userAgent: { iri: userAgentIRI, pii: true },
        claim: claimIRI,
        utmSource: utmSourceIRI,
        utmMedium: utmMediumIRI,
        utmCampaign: utmCampaignIRI,
        authRedirectUrl: authRedirectUrlIRI,
        attemptUser: attemptUserIRI,
    },
    defaults: {
        status: "pending",
    },
});
