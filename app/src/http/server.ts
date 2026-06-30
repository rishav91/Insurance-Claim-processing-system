import { buildApp } from "./app.js";
import { configureSqlitePragmas } from "../db/client.js";

/** Real server entrypoint (`npm run dev`). Tests use buildApp() + inject instead. */
const app = buildApp({ logger: true });
const port = Number(process.env.PORT ?? 3000);

configureSqlitePragmas()
  .then(() => app.listen({ port, host: "0.0.0.0" }))
  .catch((err: unknown) => {
    app.log.error(err);
    process.exit(1);
  });
