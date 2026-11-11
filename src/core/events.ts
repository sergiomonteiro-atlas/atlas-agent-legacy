import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AtlasEvent, EventType } from '../contracts.js';

export class Telemetry extends EventEmitter {
  publish(type: EventType, runId: string, agentSlug: string, data: Record<string, unknown> = {}): AtlasEvent {
    const event: AtlasEvent = { version: 1, id: randomUUID(), runId, agentSlug, type, timestamp: new Date().toISOString(), data };
    this.emit('event', event);
    return event;
  }
}
