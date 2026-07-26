import { z } from "zod";

import { failure, success } from "../../domain/result.js";
import type { Result } from "../../domain/result.js";

export const customerStatusSchema = z.enum(["active", "suspended"]);

export const customerSchema = z.strictObject({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  status: customerStatusSchema,
  createdAt: z.string().min(1),
});

export type Customer = z.infer<typeof customerSchema>;

export const createCustomerInputSchema = z.strictObject({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  status: customerStatusSchema.optional().default("active"),
});

export type CreateCustomerInput = z.input<typeof createCustomerInputSchema>;
type ParsedCreateCustomerInput = z.output<typeof createCustomerInputSchema>;

export interface CustomerRepository {
  findCustomerById(id: string): Promise<Customer | undefined>;
  claimCustomerId(id: string): Promise<boolean>;
  releaseCustomerId(id: string): Promise<void>;
  insertCustomer(customer: Customer): Promise<boolean>;
  listCustomers(): Promise<readonly Customer[]>;
}

export interface Clock {
  now(): string;
}

export interface CustomerAlreadyExists {
  readonly code: "CUSTOMER_ALREADY_EXISTS";
  readonly details: { readonly id: string };
}

export class CustomerService {
  public constructor(
    private readonly customers: CustomerRepository,
    private readonly clock: Clock,
  ) {}

  public async create(
    input: ParsedCreateCustomerInput,
  ): Promise<Result<Customer, CustomerAlreadyExists>> {
    if (!(await this.customers.claimCustomerId(input.id))) {
      return failure({
        code: "CUSTOMER_ALREADY_EXISTS",
        details: { id: input.id },
      });
    }
    try {
      const customer: Customer = {
        ...input,
        createdAt: this.clock.now(),
      };
      const inserted = await this.customers.insertCustomer(customer);
      if (!inserted) {
        await this.customers.releaseCustomerId(input.id);
      }
      return inserted
        ? success(customer)
        : failure({
            code: "CUSTOMER_ALREADY_EXISTS",
            details: { id: input.id },
          });
    } catch (error) {
      await this.customers.releaseCustomerId(input.id);
      throw error;
    }
  }

  public async get(id: string): Promise<Customer | undefined> {
    return this.customers.findCustomerById(id);
  }
}
