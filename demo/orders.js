// Demo file for the README screenshot. Not part of the extension.
async function placeOrder(cart, customer, db) {
  const order = db.orders.build({ customerId: customer.id });

  for (const item of cart.items) {
    order.lines.push({ sku: item.sku, qty: item.qty, price: item.price });
  }
  order.total = order.lines.reduce((sum, l) => sum + l.qty * l.price, 0);

  if (customer.coupon) {
    order.discount = applyCoupon(order.total, customer.coupon);
  }

  await sendReceipt(customer.email, order);
  await db.orders.save(order);
  return order;
}

function applyCoupon(total, coupon) {
  if (coupon.expired) return 0;
  return Math.min(total, total * coupon.percent / 100);
}

module.exports = { placeOrder };
