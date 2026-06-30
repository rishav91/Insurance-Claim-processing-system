import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { z } from "zod";
import type { Override } from "../domain/types.js";
import {
  adjudicateClaim,
  disputeLine,
  getClaim,
  getDispute,
  getMemberAccumulators,
  listClaims,
  payClaim,
  resolveDispute,
  reviewLine,
  submitClaim,
  type ResolutionOptions,
} from "../services/claims.js";
import { ConflictError, NotFoundError, ValidationError } from "../services/errors.js";
import { serializeClaim } from "./serialize.js";
import {
  disputeSchema,
  planYearQuerySchema,
  resolveDisputeSchema,
  reviewSchema,
  submitClaimSchema,
} from "./schemas.js";

/** Validate `data` against a zod schema; a failure is a 422 (ValidationError). */
function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const details = r.error.issues.map((i) => ({
      path: i.path.join("."),
      issue: i.message,
    }));
    throw new ValidationError("request validation failed", details);
  }
  return r.data;
}

/** Build resolution options without assigning undefined (exactOptionalPropertyTypes). */
function resolutionOpts(body: {
  overrides?: Override[] | undefined;
  note?: string | undefined;
}): ResolutionOptions {
  return {
    ...(body.overrides && { overrides: body.overrides }),
    ...(body.note !== undefined && { note: body.note }),
  };
}

export function buildApp(opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  // 1. Submit a claim → 201 `submitted`.
  app.post("/v1/claims", async (req, reply) => {
    const body = parse(submitClaimSchema, req.body);
    const view = await submitClaim({
      memberId: body.memberId,
      providerId: body.providerId,
      lines: body.lineItems.map((l) => ({
        serviceType: l.serviceType,
        serviceDate: l.serviceDate,
        billedAmountCents: l.billedAmountCents,
        ...(l.diagnosisCode !== undefined && { diagnosisCode: l.diagnosisCode }),
      })),
    });
    return reply.code(201).send(serializeClaim(view));
  });

  // 2. Adjudicate a claim → 200 (409 if already adjudicated).
  app.post<{ Params: { id: string } }>("/v1/claims/:id/adjudicate", async (req, reply) => {
    const view = await adjudicateClaim(req.params.id);
    return reply.send(serializeClaim(view));
  });

  // 3. Get a claim → 200 / 404.
  app.get<{ Params: { id: string } }>("/v1/claims/:id", async (req, reply) => {
    const view = await getClaim(req.params.id);
    if (!view) throw new NotFoundError(`claim ${req.params.id} not found`);
    return reply.send(serializeClaim(view));
  });

  // 4. List a member's claims → 200.
  app.get<{ Querystring: { memberId?: string } }>("/v1/claims", async (req, reply) => {
    const memberId = req.query.memberId;
    if (!memberId) {
      throw new ValidationError("memberId query parameter is required", [
        { path: "memberId", issue: "required" },
      ]);
    }
    return reply.send({ claims: await listClaims(memberId) });
  });

  // 5. Pay a claim → 200 / 409.
  app.post<{ Params: { id: string } }>("/v1/claims/:id/pay", async (req, reply) => {
    const view = await payClaim(req.params.id);
    return reply.send(serializeClaim(view));
  });

  // 6. Dispute a line → 201 (the dispute object, returned by the service directly).
  app.post<{ Params: { id: string } }>("/v1/lineitems/:id/dispute", async (req, reply) => {
    const body = parse(disputeSchema, req.body);
    const dispute = await disputeLine(req.params.id, body.reason);
    return reply.code(201).send(dispute);
  });

  // 7. Get a dispute → 200 / 404.
  app.get<{ Params: { id: string } }>("/v1/disputes/:id", async (req, reply) => {
    const dispute = await getDispute(req.params.id);
    if (!dispute) throw new NotFoundError(`dispute ${req.params.id} not found`);
    return reply.send(dispute);
  });

  // 8. Resolve a dispute → 200 (422 on conflicting overrides).
  app.post<{ Params: { id: string } }>("/v1/disputes/:id/resolve", async (req, reply) => {
    const body = parse(resolveDisputeSchema, req.body);
    const dispute = await getDispute(req.params.id);
    if (!dispute) throw new NotFoundError(`dispute ${req.params.id} not found`);
    const view = await resolveDispute(dispute.lineItemId, body.action, resolutionOpts(body));
    return reply.send(serializeClaim(view));
  });

  // 9. Resolve a pended line → 200 / 409.
  app.post<{ Params: { id: string } }>("/v1/lineitems/:id/review", async (req, reply) => {
    const body = parse(reviewSchema, req.body);
    const view = await reviewLine(req.params.id, body.action, resolutionOpts(body));
    return reply.send(serializeClaim(view));
  });

  // 10. Member accumulators → 200 (usage summed live from the ledger).
  app.get<{ Params: { id: string }; Querystring: { planYear?: string } }>(
    "/v1/members/:id/accumulators",
    async (req, reply) => {
      const q = parse(planYearQuerySchema, req.query);
      const planYear = q.planYear ?? new Date().getUTCFullYear();
      return reply.send(await getMemberAccumulators(req.params.id, planYear));
    },
  );

  // Domain/validation errors → the single envelope shape (docs/api.md).
  app.setErrorHandler((error: FastifyError, _req, reply) => {
    if (error instanceof ValidationError) {
      return reply.code(422).send({
        error: { code: "VALIDATION_FAILED", message: error.message, details: error.details },
      });
    }
    if (error instanceof NotFoundError) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: error.message } });
    }
    if (error instanceof ConflictError) {
      return reply.code(409).send({ error: { code: "CONFLICT", message: error.message } });
    }
    // Malformed JSON / bad content-type → Fastify sets a 4xx statusCode.
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({
        error: { code: error.code ?? "BAD_REQUEST", message: error.message },
      });
    }
    app.log.error(error);
    return reply.code(500).send({ error: { code: "INTERNAL", message: "Internal server error" } });
  });

  app.setNotFoundHandler((req, reply) => {
    return reply.code(404).send({
      error: { code: "NOT_FOUND", message: `route ${req.method} ${req.url} not found` },
    });
  });

  return app;
}
