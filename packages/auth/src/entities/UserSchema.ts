import { avatarUrlIRI, displayNameIRI, emailIRI, UserIRI } from "@terncosoftware/core";
import { EntitySchema } from "@terncosoftware/entities";
import { AUTH_NS } from "../constants.js";

export const UserSchema = new EntitySchema({
    typeIRI: UserIRI,
    ns: AUTH_NS,
    properties: {
        // Equality lookups are supported for encrypted properties by EntityQuery;
        // the filter decrypts its tenant-scoped candidates in memory.
        email: { iri: emailIRI, pii: true },
        displayName: { iri: displayNameIRI, pii: true },
        avatarUrl: { iri: avatarUrlIRI, pii: true },
    },
});
