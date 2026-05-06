import type { Event, Exporter, ExporterConfig } from "../types.js";
import {
  DatadogExporter,
  type DatadogExporterConfig,
} from "./exporters/datadog.js";
import { OTLPExporter, type OTLPExporterConfig } from "./exporters/otlp.js";
import {
  PostHogExporter,
  type PostHogExporterConfig,
} from "./exporters/posthog.js";
import {
  SentryExporter,
  type SentryExporterConfig,
} from "./exporters/sentry.js";
import { writeToLog } from "./logging.js";

export class TelemetryManager {
  private readonly exporters: Map<string, Exporter> = new Map();

  constructor(exporterConfigs?: Record<string, ExporterConfig>) {
    if (!exporterConfigs) {
      return;
    }

    for (const [name, config] of Object.entries(exporterConfigs)) {
      try {
        const exporter = this.createExporter(config);
        if (exporter) {
          this.exporters.set(name, exporter);
          writeToLog(`Initialized telemetry exporter: ${name}`);
        }
      } catch (error) {
        writeToLog(`Failed to initialize exporter ${name}: ${error}`);
      }
    }
  }

  private createExporter(config: ExporterConfig): Exporter | null {
    switch (config.type) {
      case "otlp":
        return new OTLPExporter(config as unknown as OTLPExporterConfig);
      case "datadog":
        return new DatadogExporter(config as unknown as DatadogExporterConfig);
      case "sentry":
        return new SentryExporter(config as unknown as SentryExporterConfig);
      case "posthog":
        return new PostHogExporter(config as unknown as PostHogExporterConfig);
      default:
        writeToLog(`Unknown exporter type: ${config.type}`);
        return null;
    }
  }

  export(event: Event): Promise<void> {
    if (this.exporters.size === 0) {
      return Promise.resolve();
    }

    // Telemetry errors should be logged but not propagated
    for (const [name, exporter] of this.exporters) {
      exporter.export(event).catch((error) => {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        writeToLog(`Telemetry export failed for ${name}: ${errorMessage}`);
      });
    }
    return Promise.resolve();
  }

  getExporterCount(): number {
    return this.exporters.size;
  }
}
