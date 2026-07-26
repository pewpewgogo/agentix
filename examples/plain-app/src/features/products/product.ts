import { z } from "zod";

import { failure, success } from "../../domain/result.js";
import type { Result } from "../../domain/result.js";
import type { Clock } from "../customers/customer.js";

const safeInteger = z.number().int().safe();

export const productSchema = z.strictObject({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  unitPriceCents: safeInteger.positive(),
  stock: safeInteger.nonnegative(),
  createdAt: z.string().min(1),
});

export type Product = z.infer<typeof productSchema>;

export const createProductInputSchema = z.strictObject({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  unitPriceCents: safeInteger.positive(),
  stock: safeInteger.nonnegative(),
});

type CreateProductInput = z.output<typeof createProductInputSchema>;

export interface ProductRepository {
  findProductById(id: string): Promise<Product | undefined>;
  claimProductId(id: string): Promise<boolean>;
  releaseProductId(id: string): Promise<void>;
  insertProduct(product: Product): Promise<boolean>;
  listProducts(): Promise<readonly Product[]>;
}

export interface ProductAlreadyExists {
  readonly code: "PRODUCT_ALREADY_EXISTS";
  readonly details: { readonly id: string };
}

export class ProductService {
  public constructor(
    private readonly products: ProductRepository,
    private readonly clock: Clock,
  ) {}

  public async create(
    input: CreateProductInput,
  ): Promise<Result<Product, ProductAlreadyExists>> {
    if (!(await this.products.claimProductId(input.id))) {
      return failure({
        code: "PRODUCT_ALREADY_EXISTS",
        details: { id: input.id },
      });
    }
    try {
      const product: Product = {
        ...input,
        createdAt: this.clock.now(),
      };
      const inserted = await this.products.insertProduct(product);
      if (!inserted) {
        await this.products.releaseProductId(input.id);
      }
      return inserted
        ? success(product)
        : failure({
            code: "PRODUCT_ALREADY_EXISTS",
            details: { id: input.id },
          });
    } catch (error) {
      await this.products.releaseProductId(input.id);
      throw error;
    }
  }

  public async get(id: string): Promise<Product | undefined> {
    return this.products.findProductById(id);
  }
}
