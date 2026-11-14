import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";
export const registry = new Registry();
registry.setDefaultLabels({ service: "attendflow-api" });
collectDefaultMetrics({ register: registry, prefix: "attendflow_" });
export const httpRequests = new Counter({ name: "attendflow_http_requests_total", help: "HTTP requests served", labelNames: ["method", "route", "status"], registers: [registry] });
export const httpDuration = new Histogram({ name: "attendflow_http_request_duration_seconds", help: "HTTP request duration", labelNames: ["method", "route", "status"], buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: [registry] });
