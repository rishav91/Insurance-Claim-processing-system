import Fastify, { type FastifyInstance } from "fastify";

/** Build the HTTP app (no routes yet — Phase 5 green wires them). */
export function buildApp(): FastifyInstance {
  return Fastify({ logger: false });
}
