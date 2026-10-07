/** The key a running worker keeps refreshing (services/fingerprinter/workers/heartbeat.py writes the same one). */
export function workerHeartbeatKey(queueKeyPrefix: string, queueName: string): string {
  return `${queueKeyPrefix}:worker-heartbeat:${queueName}`;
}
