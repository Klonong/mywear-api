# MyWear database ERD

<!-- Generated from prisma/schema.prisma by `npm run db:erd`. Do not edit by hand. -->

22 tables, 11 enums. Money columns are integer IDR. `PK` primary key, `FK` foreign key, `UK` unique.
Crow's feet read as: `||` exactly one, `|o` zero or one, `o{` zero or many.

```mermaid
erDiagram
  User ||--o{ Session : "sessions"
  User ||--o{ PasswordReset : "resets"
  User ||--o{ Address : "addresses"
  Category |o--o{ Category : "children"
  Category ||--o{ Product : "products"
  Product ||--o{ ProductColor : "colors"
  ProductColor ||--o{ ProductImage : "images"
  ProductColor ||--o{ Sku : "skus"
  User |o--o| Cart : "cart"
  Cart ||--o{ CartItem : "items"
  Sku ||--o{ CartItem : "cartItems"
  User ||--o{ WishlistItem : "wishlist"
  Product ||--o{ WishlistItem : "wishlistedBy"
  User |o--o{ Order : "orders"
  Order ||--o{ OrderItem : "items"
  Sku ||--o{ OrderItem : "orderItems"
  Order ||--o{ Payment : "payments"
  Order ||--o{ Shipment : "shipments"
  Order ||--o{ OrderNote : "notes"
  Order ||--o{ ReturnRequest : "returns"
  Product ||--o{ Review : "reviews"
  User ||--o{ Review : "reviews"
  OrderItem |o--o{ Review : "reviews"
  Sku ||--o{ StockAlert : "alerts"

  User {
    String id PK
    String email UK
    String passwordHash
    String name
    String phone "nullable"
    DateTime birthday "nullable"
    Gender preferredGender "nullable"
    Role role
    DateTime createdAt
  }
  Session {
    String id PK
    String userId FK
    String tokenHash UK
    DateTime expiresAt
    DateTime createdAt
  }
  PasswordReset {
    String id PK
    String userId FK
    String tokenHash UK
    DateTime expiresAt
    DateTime usedAt "nullable"
  }
  Address {
    String id PK
    String userId FK
    String recipient
    String phone
    String line1
    String line2 "nullable"
    String city
    String province "nullable"
    String postcode
    Boolean isDefault
  }
  Category {
    String id PK
    Gender gender
    String name
    String slug
    Int sortOrder
    String parentId FK "nullable"
  }
  Product {
    String id PK
    String slug UK
    String name
    String description
    Gender gender
    String categoryId FK
    String sport
    String material
    String fit
    Badge badge "nullable"
    String notice "nullable"
    Boolean voucherEligible
    ProductStatus status
    Float ratingAvg
    Int ratingCount
    DateTime createdAt
  }
  ProductColor {
    String id PK
    String productId FK
    String name
    String hex
    String tone
    Int sortOrder
  }
  ProductImage {
    String id PK
    String colorId FK
    String url
    String alt
    Int sortOrder
  }
  Sku {
    String id PK
    String colorId FK
    String size
    String sku UK
    Int price
    Int salePrice "nullable"
    Int stock
    Int reserved
  }
  Cart {
    String id PK
    String token UK
    String userId FK, UK "nullable"
    String promoCode "nullable"
    DateTime updatedAt
  }
  CartItem {
    String id PK
    String cartId FK
    String skuId FK
    Int qty
  }
  WishlistItem {
    String id PK
    String userId FK
    String productId FK
    DateTime createdAt
  }
  Order {
    String id PK
    String number UK
    String userId FK "nullable"
    String email
    String phone
    OrderStatus status
    DeliveryMethod deliveryMethod
    PaymentMethod paymentMethod
    String promoCode "nullable"
    Int subtotal
    Int discount
    Int shipping
    Int total
    Json addressSnapshot
    DateTime reservationExpiresAt "nullable"
    DateTime paidAt "nullable"
    DateTime createdAt
  }
  OrderItem {
    String id PK
    String orderId FK
    String skuId FK
    String productSlug
    String nameSnapshot
    String colorSnapshot
    String sizeSnapshot
    Int unitPrice
    Int qty
  }
  Payment {
    String id PK
    String orderId FK
    String provider
    String providerRef "nullable"
    PaymentMethod method
    PaymentStatus status
    Int amount
    DateTime createdAt
  }
  Shipment {
    String id PK
    String orderId FK
    String courier
    String trackingNumber
    DateTime createdAt
  }
  OrderNote {
    String id PK
    String orderId FK
    String author
    String body
    DateTime createdAt
  }
  ReturnRequest {
    String id PK
    String orderId FK
    Json items
    String reason
    DateTime createdAt
  }
  Promotion {
    String id PK
    String code UK
    PromotionType type
    Int value
    Int minSpend
    DateTime startsAt "nullable"
    DateTime endsAt "nullable"
    Int usageLimit "nullable"
    Int usedCount
    Boolean active
    DateTime createdAt
  }
  Review {
    String id PK
    String productId FK
    String userId FK
    String orderItemId FK "nullable"
    Int rating
    ReviewFit fit
    String title
    String body
    ReviewStatus status
    DateTime createdAt
  }
  StockAlert {
    String id PK
    String skuId FK
    String email
    DateTime createdAt
    DateTime notifiedAt "nullable"
  }
  NewsletterSubscriber {
    String id PK
    String email UK
    String tokenHash UK
    DateTime confirmedAt "nullable"
    DateTime createdAt
  }
```

## Enums

| Enum | Values |
|---|---|
| Gender | `women`, `men`, `kids` |
| Role | `customer`, `admin`, `merchandiser`, `support` |
| Badge | `New`, `Sale`, `Limited` |
| ProductStatus | `draft`, `published`, `archived` |
| OrderStatus | `pending_payment`, `paid`, `processing`, `shipped`, `delivered`, `cancelled`, `return_requested`, `returned`, `refunded` |
| DeliveryMethod | `standard`, `express` |
| PaymentMethod | `card`, `ewallet`, `va` |
| PaymentStatus | `pending`, `paid`, `failed`, `refunded` |
| PromotionType | `percent`, `fixed`, `free_delivery` |
| ReviewFit | `runs_small`, `true_to_size`, `runs_large` |
| ReviewStatus | `pending`, `approved`, `rejected` |

## Reading the model

- **Catalogue**: `Product` → `ProductColor` → `Sku` (one per colour and size, carries price and stock) and `ProductImage`. Sellable quantity is `stock - reserved`.
- **Orders** keep snapshots (`OrderItem.nameSnapshot`, `Order.addressSnapshot`) so later catalogue edits never rewrite history. `OrderItem` still links its `Sku`, which is why products are archived, not deleted.
- **Checkout** raises `Sku.reserved` until payment; `Order.reservationExpiresAt` drives the release job.
- **Carts** belong to a guest (`token` cookie) or a user (`userId`, one bag per user).
- `Promotion` and `NewsletterSubscriber` stand alone: orders store the promo `code`, not a foreign key.
