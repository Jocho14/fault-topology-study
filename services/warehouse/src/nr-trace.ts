/*
 * New Relic distributed-trace propagation across RabbitMQ.
 *
 * The NestJS RMQ transport hides the AMQP message headers, so the New Relic
 * agent cannot link a producer's trace to the consumer's. We bridge it by
 * carrying the trace context inside the event payload under `_nr`: the
 * producer injects it right before emit(), the consumer accepts it at the
 * very start of the @EventPattern handler (and strips it before use).
 *
 * newrelic ships no TS types; tsconfig has noImplicitAny:false so the
 * import-require resolves to `any` and the API calls type-check.
 */
import newrelic = require('newrelic');

export type WithTrace<T> = T & { _nr?: Record<string, string> };

// Producer: embed the current distributed-trace context into an outgoing event.
export function injectTrace<T extends object>(data: T): WithTrace<T> {
  try {
    const headers: Record<string, string> = {};
    const tx = newrelic.getTransaction();
    tx.insertDistributedTraceHeaders(headers);
    return { ...data, _nr: headers };
  } catch {
    return data as WithTrace<T>;
  }
}

// Consumer: link this transaction to the producer's trace, then drop `_nr`.
export function acceptTrace(data: Record<string, any>): void {
  try {
    if (data && data._nr) {
      const tx = newrelic.getTransaction();
      tx.acceptDistributedTraceHeaders('Queue', data._nr);
      delete data._nr;
    }
  } catch {
    /* no active transaction; ignore */
  }
}
