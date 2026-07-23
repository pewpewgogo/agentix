import type {
  Customer,
  CustomerRepository,
} from "../features/customers/customer.js";
import type {
  Order,
  OrderCreatedEvent,
  OrderRepository,
  PaidOrderCommit,
  PaidOrderCommitResult,
  Payment,
} from "../features/orders/order.js";
import type {
  Product,
  ProductRepository,
} from "../features/products/product.js";

const cloneCustomer = (customer: Customer): Customer => ({ ...customer });
const cloneProduct = (product: Product): Product => ({ ...product });
const cloneOrder = (order: Order): Order => ({ ...order });
const clonePayment = (payment: Payment): Payment => ({ ...payment });
const cloneEvent = (event: OrderCreatedEvent): OrderCreatedEvent => ({
  ...event,
  data: { ...event.data },
});

export class InMemoryCommerceStore
  implements CustomerRepository, ProductRepository, OrderRepository
{
  readonly #customers = new Map<string, Customer>();
  readonly #customerClaims = new Set<string>();
  readonly #products = new Map<string, Product>();
  readonly #productClaims = new Set<string>();
  readonly #orders = new Map<string, Order>();
  readonly #payments = new Map<string, Payment>();
  readonly #events: OrderCreatedEvent[] = [];

  public async findCustomerById(id: string): Promise<Customer | undefined> {
    const customer = this.#customers.get(id);
    return customer === undefined ? undefined : cloneCustomer(customer);
  }

  public async claimCustomerId(id: string): Promise<boolean> {
    if (this.#customers.has(id) || this.#customerClaims.has(id)) {
      return false;
    }
    this.#customerClaims.add(id);
    return true;
  }

  public async releaseCustomerId(id: string): Promise<void> {
    this.#customerClaims.delete(id);
  }

  public async insertCustomer(customer: Customer): Promise<boolean> {
    if (this.#customers.has(customer.id)) {
      this.#customerClaims.delete(customer.id);
      return false;
    }
    this.#customers.set(customer.id, cloneCustomer(customer));
    this.#customerClaims.delete(customer.id);
    return true;
  }

  public async listCustomers(): Promise<readonly Customer[]> {
    return [...this.#customers.values()].map(cloneCustomer);
  }

  public async findProductById(id: string): Promise<Product | undefined> {
    const product = this.#products.get(id);
    return product === undefined ? undefined : cloneProduct(product);
  }

  public async claimProductId(id: string): Promise<boolean> {
    if (this.#products.has(id) || this.#productClaims.has(id)) {
      return false;
    }
    this.#productClaims.add(id);
    return true;
  }

  public async releaseProductId(id: string): Promise<void> {
    this.#productClaims.delete(id);
  }

  public async insertProduct(product: Product): Promise<boolean> {
    if (this.#products.has(product.id)) {
      this.#productClaims.delete(product.id);
      return false;
    }
    this.#products.set(product.id, cloneProduct(product));
    this.#productClaims.delete(product.id);
    return true;
  }

  public async listProducts(): Promise<readonly Product[]> {
    return [...this.#products.values()].map(cloneProduct);
  }

  public async findOrderById(id: string): Promise<Order | undefined> {
    const order = this.#orders.get(id);
    return order === undefined ? undefined : cloneOrder(order);
  }

  public async listOrders(): Promise<readonly Order[]> {
    return [...this.#orders.values()].map(cloneOrder);
  }

  public async listPayments(): Promise<readonly Payment[]> {
    return [...this.#payments.values()].map(clonePayment);
  }

  public async listEvents(): Promise<readonly OrderCreatedEvent[]> {
    return this.#events.map(cloneEvent);
  }

  public async commitPaidOrder(
    commit: PaidOrderCommit,
  ): Promise<PaidOrderCommitResult> {
    if (this.#orders.has(commit.order.id)) {
      return "duplicate-order";
    }
    const product = this.#products.get(commit.order.productId);
    if (product === undefined || product.stock < commit.order.quantity) {
      return "insufficient-stock";
    }

    this.#products.set(product.id, {
      ...product,
      stock: product.stock - commit.order.quantity,
    });
    this.#orders.set(commit.order.id, cloneOrder(commit.order));
    this.#payments.set(commit.payment.id, clonePayment(commit.payment));
    this.#events.push(cloneEvent(commit.event));
    return "committed";
  }
}
