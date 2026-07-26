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
  readonly details: { readonly id: string };
}

export interface ProductNotFound {
  readonly code: "PRODUCT_NOT_FOUND";
  readonly details: { readonly id: string };
}

export interface CustomerSuspended {
  readonly code: "CUSTOMER_SUSPENDED";
  readonly details: { readonly id: string };
}

export interface OutOfStock {
  readonly code: "OUT_OF_STOCK";
  readonly details: {
    readonly productId: string;
    readonly requested: number;
    readonly available: number;
  };
}

export interface PaymentDeclined {
  readonly code: "PAYMENT_DECLINED";
  readonly details: Record<string, never>;
}

export type CreateOrderError =
  | CustomerNotFound
  | ProductNotFound
  | CustomerSuspended
  | OutOfStock
  | PaymentDeclined;

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
      return failure({
        code: "CUSTOMER_NOT_FOUND",
        details: { id: input.customerId },
      });
    }
    if (customer.status === "suspended") {
      return failure({
        code: "CUSTOMER_SUSPENDED",
        details: { id: customer.id },
      });
    }

    const product = await this.products.findProductById(input.productId);
    if (product === undefined) {
      return failure({
        code: "PRODUCT_NOT_FOUND",
        details: { id: input.productId },
      });
    }
    if (product.stock < input.quantity) {
      return failure({
        code: "OUT_OF_STOCK",
        details: {
          productId: product.id,
          requested: input.quantity,
          available: product.stock,
        },
      });
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
      const current = await this.products.findProductById(product.id);
      return failure({
        code: "OUT_OF_STOCK",
        details: {
          productId: product.id,
          requested: input.quantity,
          available: current?.stock ?? 0,
        },
      });
    }
    if (committed === "duplicate-order") {
      throw new Error(`Order ID ${id} already exists.`);
    }
    return success(order);
  }
}
