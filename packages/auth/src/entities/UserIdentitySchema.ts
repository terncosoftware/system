import {
    accessTokenIRI,
    identityOfIRI,
    providerEmailIRI,
    providerIRI,
    providerUserIdIRI,
    refreshTokenIRI,
    tokenExpiresAtIRI,
    UserIdentityIRI,
} from "@terncosoftware/core";
import { EntitySchema } from "@terncosoftware/entities";
import { AUTH_NS } from "../constants.js";

export const UserIdentitySchema = new EntitySchema({
    typeIRI: UserIdentityIRI,
    ns: AUTH_NS,
    properties: {
        provider: providerIRI,
        // Stable provider identifiers and emails are personal data too.
        providerUserId: { iri: providerUserIdIRI, pii: true },
        providerEmail: { iri: providerEmailIRI, pii: true },
        // accessToken / refreshToken are secrets and are encrypted at rest:
        // EntityStore encrypts them on write and decrypts on read, so the nodes
        // table holds ciphertext while repo callers see cleartext.
        accessToken: { iri: accessTokenIRI, pii: true },
        refreshToken: { iri: refreshTokenIRI, pii: true },
        tokenExpiresAt: tokenExpiresAtIRI,
        // The owning user, stored as a property holding the user's IRI — matching
        // how sessionUser / deviceUser / attemptUser are modeled on their schemas.
        identityOf: identityOfIRI,
    },
});
