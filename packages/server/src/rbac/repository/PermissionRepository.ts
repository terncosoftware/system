import type { TripleStore } from "@terncosoftware/data";
import type { EntityRecord } from "@terncosoftware/entities";
import { idFromIri } from "@terncosoftware/entities";
import { EntityQuery } from "../../EntityQuery.js";
import type { EntityStore } from "../../EntityStore.js";
import { createEntityStore } from "../../EntityStoreFactory.js";
import type { SecurityContext } from "../../SecurityContext.js";
import type { ServerContext } from "../../ServerContext.js";
import { PermissionSchema } from "../schemas.generated.js";
import type { PermissionEntity } from "../types.js";

export interface IdArgs {
    id: string;
}

export interface IriStrArgs {
    iriStr: string;
}

export interface KeyArgs {
    key: string;
}

/**
 * Data-access layer for Permission entities in the rbac bounded context.
 *
 * Repositories are the trusted persistence layer and perform NO access checks
 * by design (TRN-205); authorization is enforced one level up by RbacService.
 * The `_sec` argument is threaded for signature symmetry only.
 */
export class PermissionRepository {
    private readonly _store: TripleStore;
    private readonly _es: EntityStore;

    constructor(store: TripleStore) {
        this._store = store;
        this._es = createEntityStore(store);
    }

    /** @dataLayer — no checks here; RbacService enforces (see class doc). */
    async create(
        ctx: ServerContext,
        sec: SecurityContext,
        args: Pick<PermissionEntity, "permissionKey">,
    ): Promise<PermissionEntity> {
        const rec = await this._es.create(ctx, PermissionSchema, {
            permissionKey: args.permissionKey,
        });
        return toPermission(rec);
    }

    /** @dataLayer — no checks here; RbacService enforces (see class doc). */
    async findById(
        ctx: ServerContext,
        sec: SecurityContext,
        args: IdArgs,
    ): Promise<PermissionEntity | null> {
        const rec = await this._es.findById(ctx, PermissionSchema, args.id);
        return rec ? toPermission(rec) : null;
    }

    /** @dataLayer — no checks here; RbacService enforces (see class doc). */
    async findByIri(
        ctx: ServerContext,
        sec: SecurityContext,
        args: IriStrArgs,
    ): Promise<PermissionEntity | null> {
        return this.findById(ctx, sec, { id: idFromIri(args.iriStr) });
    }

    /**
     * @dataLayer — no checks here; RbacService enforces. Find a permission by its
     * dot-separated key (e.g. "invoice.read") in the caller's tenant graph only:
     * EntityQuery scans run in tenantGraph(ctx) (TRN-531), so a tenant never
     * resolves another tenant's permission (TRN-214).
     */
    async findByKey(
        ctx: ServerContext,
        sec: SecurityContext,
        args: KeyArgs,
    ): Promise<PermissionEntity | null> {
        const rec = await EntityQuery.from(this._store, PermissionSchema)
            .where("permissionKey", "=", args.key)
            .first(ctx);
        return rec ? toPermission(rec) : null;
    }
}

function toPermission(rec: EntityRecord): PermissionEntity {
    return {
        id: rec.id,
        iri: rec.iri,
        permissionKey: rec.props.permissionKey as string,
    };
}
