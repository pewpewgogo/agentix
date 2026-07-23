import { failure, success } from "../domain/result.js";
import type { Result } from "../domain/result.js";
import type {
  PaymentDeclined,
  PaymentGateway,
} from "../features/orders/order.js";

export type PaymentOutcome = "approved" | "declined";

export class ScriptedPaymentGateway implements PaymentGateway {
  readonly #outcomes: PaymentOutcome[];

  public constructor(outcomes: readonly PaymentOutcome[] = []) {
    this.#outcomes = [...outcomes];
  }

  public async authorize(
    _input: Parameters<PaymentGateway["authorize"]>[0],
  ): Promise<Result<"approved", PaymentDeclined>> {
    const outcome = this.#outcomes.shift() ?? "approved";
    return outcome === "approved"
      ? success("approved" as const)
      : failure({
          code: "PAYMENT_DECLINED" as const,
          message: "Payment was declined." as const,
        });
  }
}
