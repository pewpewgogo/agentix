import { COMMERCE_ERRORS } from "@agentixdev/shared-contract";
import { z } from "zod";

import { failure, success } from "../../domain/result.js";
import type { Result } from "../../domain/result.js";
import type {
  Clock,
  CustomerRepository,
} from "../customers/customer.js";
import type { ProductRepository } from "../products/product.js";
import { paidOrderHasApprovedPayment } from "./paid-order-invariant.js";

const safeInteger = z.number().int().safe();

export const createOrderInputSchema = z.strictObject({
  customerId: z.string().trim().min(1),
  productId: z.string().trim().min(1),
  quantity: safeInteger.positive(),
});

type CreateOrderInput = z.output<typeof createOrderInputSchema>;

export interface Order {
  readonly id: string;
  readonly customerId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly totalCents: number;
  readonly status: "paid";
  readonly createdAt: string;
}

export interface Payment {
  readonly id: string;
  readonly orderId: string;
  readonly amountCents: number;
  readonly status: "approved";
  readonly processedAt: string;
}

export interface OrderCreatedEvent {
  readonly id: string;
  readonly type: "order.created";
  readonly occurredAt: string;
  readonly data: {
    readonly orderId: string;
    readonly customerId: string;
    readonly productId: string;
    readonly quantity: number;
    readonly totalCents: number;
  };
}

export interface PaidOrderCommit {
  readonly order: Order;
  readonly payment: Payment;
  readonly event: OrderCreatedEvent;
}

export type PaidOrderCommitResult =
  | "committed"
  | "insufficient-stock"
  | "duplicate-order";

export interface OrderRepository {
  findOrderById(id: string): Promise<Order | undefined>;
  listOrders(): Promise<readonly Order[]>;
  listPayments(): Promise<readonly Payment[]>;
  listEvents(): Promise<readonly OrderCreatedEvent[]>;
  commitPaidOrder(commit: PaidOrderCommit): Promise<PaidOrderCommitResult>;
}

export interface PaymentGateway {
  authorize(input: {
    readonly customerId: string;
    readonly amountCents: number;
  }): Promise<Result<"approved", PaymentDeclined>>;
}

export interface OrderIdGenerator {
  next(): string;
}

export interface CustomerNotFound {
  readonly code: "CUSTOMER_NOT_FOUND";
  readonly message: "Customer not found.";
}

export interface ProductNotFound {
  readonly code: "PRODUCT_NOT_FOUND";
  readonly message: "Product not found.";
}

export interface CustomerSuspended {
  readonly code: "CUSTOMER_SUSPENDED";
  readonly message: "Customer is suspended.";
}

export interface OutOfStock {
  readonly code: "OUT_OF_STOCK";
  readonly message: "Insufficient product stock.";
}

export interface PaymentDeclined {
  readonly code: "PAYMENT_DECLINED";
  readonly message: "Payment was declined.";
}

export type CreateOrderError =
  | CustomerNotFound
  | ProductNotFound
  | CustomerSuspended
  | OutOfStock
  | PaymentDeclined;

const domainError = <
  const TError extends { readonly code: string; readonly message: string },
>(
  error: TError,
): Pick<TError, "code" | "message"> => ({
  code: error.code,
  message: error.message,
});

const errors = {
  customerNotFound: domainError(COMMERCE_ERRORS.customerNotFound),
  productNotFound: domainError(COMMERCE_ERRORS.productNotFound),
  customerSuspended: domainError(COMMERCE_ERRORS.customerSuspended),
  outOfStock: domainError(COMMERCE_ERRORS.outOfStock),
} as const;

export class OrderService {
  #tail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly customers: CustomerRepository,
    private readonly products: ProductRepository,
    private readonly orders: OrderRepository,
    private readonly payments: PaymentGateway,
    private readonly clock: Clock,
    private readonly ids: OrderIdGenerator,
  ) {}

  /** Serialize the payment-and-commit section so concurrent requests cannot oversell. */
  public async create(
    input: CreateOrderInput,
  ): Promise<Result<Order, CreateOrderError>> {
    let release = (): void => undefined;
    const predecessor = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;

    try {
      return await this.createExclusive(input);
    } finally {
      release();
    }
  }

  public async get(id: string): Promise<Order | undefined> {
    return this.orders.findOrderById(id);
  }

  public async events(): Promise<readonly OrderCreatedEvent[]> {
    return this.orders.listEvents();
  }

  private async createExclusive(
    input: CreateOrderInput,
  ): Promise<Result<Order, CreateOrderError>> {
    const customer = await this.customers.findCustomerById(input.customerId);
    if (customer === undefined) {
      return failure(errors.customerNotFound);
    }
    if (customer.status === "suspended") {
      return failure(errors.customerSuspended);
    }

    const product = await this.products.findProductById(input.productId);
    if (product === undefined) {
      return failure(errors.productNotFound);
    }
    if (product.stock < input.quantity) {
      return failure(errors.outOfStock);
    }

    const totalCents = product.unitPriceCents * input.quantity;
    if (!Number.isSafeInteger(totalCents)) {
      throw new RangeError("The order total exceeds the safe integer range.");
    }
    const authorization = await this.payments.authorize({
      customerId: customer.id,
      amountCents: totalCents,
    });
    if (!authorization.ok) {
      return authorization;
    }

    const id = this.ids.next().trim();
    if (id.length === 0) {
      throw new TypeError("The generated order ID must not be empty.");
    }
    const createdAt = this.clock.now();
    const order: Order = {
      id,
      customerId: customer.id,
      productId: product.id,
      quantity: input.quantity,
      totalCents,
      status: "paid",
      createdAt,
    };
    const payment: Payment = {
      id: `payment:${id}`,
      orderId: id,
      amountCents: totalCents,
      status: "approved",
      processedAt: createdAt,
    };
    const event: OrderCreatedEvent = {
      id: `event:order.created:${id}`,
      type: "order.created",
      occurredAt: createdAt,
      data: {
        orderId: id,
        customerId: customer.id,
        productId: product.id,
        quantity: input.quantity,
        totalCents,
      },
    };

    if (!paidOrderHasApprovedPayment(order, payment)) {
      throw new Error("A paid order must have its approved payment.");
    }
    const committed = await this.orders.commitPaidOrder({ order, payment, event });
    if (committed === "insufficient-stock") {
      return failure(errors.outOfStock);
    }
    if (committed === "duplicate-order") {
      throw new Error(`Order ID ${id} already exists.`);
    }
    return success(order);
  }
}
