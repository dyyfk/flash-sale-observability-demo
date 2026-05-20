CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  stock INTEGER NOT NULL CHECK (stock >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  idempotency_key TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'retrying', 'accepted', 'rejected', 'failed')),
  failure_reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_product_created_idx ON orders(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_created_idx ON orders(status, created_at DESC);

INSERT INTO products (id, name, price_cents, stock)
VALUES
  (1, 'Launch Day Keyboard', 12900, 100000),
  (2, 'Limited Edition Hoodie', 8900, 60000),
  (3, 'Noise Cancelling Headphones', 19900, 40000)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    price_cents = EXCLUDED.price_cents,
    stock = GREATEST(products.stock, EXCLUDED.stock),
    updated_at = now();
