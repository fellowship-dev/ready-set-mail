// The product version: the root package.json `version`. /health, GET /api/version, the weekly digest, the MCP
// server's serverInfo and telemetry all report this one number. Workspace packages (packages/*, web/) and the agent
// plugin keep their own internal 0.x versions; nothing reads those as the product version.
import { version } from '../package.json';

export const PRODUCT_VERSION: string = version;
