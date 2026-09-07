"""Sample target app for Cartographer.

A deliberately plain server-rendered admin UI with real mutating actions
(refund, delete, settings save) so exploration has something to revert.

Vision-first exploration reads this UI from a screenshot, so every control is a
real <button>/<a> with distinct, readable text and a >=32px hit target.
"""

import os
import sqlite3
from functools import wraps

from flask import (
    Flask,
    g,
    redirect,
    request,
    session,
    url_for,
)

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shop.db")

app = Flask(__name__)
app.secret_key = "cartographer-sample-app"  # sample app; not a real secret


def get_db():
    if "db" not in g:
        # isolation_level=None -> autocommit, so writes land immediately.
        # journal_mode=DELETE -> changes go into shop.db itself, not a -wal sidecar.
        # WHY: Cartographer digests shop.db to detect mutations; WAL would hide them.
        conn = sqlite3.connect(DB_PATH, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=DELETE")
        g.db = conn
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


CUSTOMERS = [
    (1, "Ada Lovelace", "ada@example.com", "London"),
    (2, "Grace Hopper", "grace@example.com", "New York"),
    (3, "Alan Turing", "alan@example.com", "Manchester"),
    (4, "Katherine Johnson", "katherine@example.com", "Hampton"),
    (5, "Edsger Dijkstra", "edsger@example.com", "Rotterdam"),
    (6, "Barbara Liskov", "barbara@example.com", "Boston"),
]

# (id, customer_id, item, amount_cents, status) - fixed so runs are comparable.
ORDERS = [
    (1, 1, "Mechanical keyboard", 12900, "paid"),
    (2, 2, "27in monitor", 31500, "paid"),
    (3, 3, "USB-C dock", 8900, "paid"),
    (4, 4, "Noise cancelling headphones", 24900, "shipped"),
    (5, 5, "Standing desk", 45000, "paid"),
    (6, 6, "Ergonomic chair", 38900, "shipped"),
    (7, 1, "Webcam 4K", 15900, "paid"),
    (8, 2, "Cable organiser", 1900, "delivered"),
    (9, 3, "Laptop stand", 5900, "paid"),
    (10, 4, "Mouse pad XL", 2400, "delivered"),
    (11, 5, "Docking hub", 10900, "shipped"),
    (12, 6, "Desk lamp", 7400, "paid"),
]


def init_db():
    if os.path.exists(DB_PATH):
        return
    conn = sqlite3.connect(DB_PATH, isolation_level=None)
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.executescript(
        """
        CREATE TABLE customers (
            id INTEGER PRIMARY KEY, name TEXT, email TEXT, city TEXT
        );
        CREATE TABLE orders (
            id INTEGER PRIMARY KEY, customer_id INTEGER, item TEXT,
            amount_cents INTEGER, status TEXT
        );
        CREATE TABLE settings (
            id INTEGER PRIMARY KEY CHECK (id = 1), store_name TEXT, currency TEXT
        );
        """
    )
    conn.executemany("INSERT INTO customers VALUES (?,?,?,?)", CUSTOMERS)
    conn.executemany("INSERT INTO orders VALUES (?,?,?,?,?)", ORDERS)
    conn.execute("INSERT INTO settings VALUES (1, 'Cartographer Shop', 'USD')")
    conn.close()


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get("user"):
            return redirect(url_for("login"))
        return fn(*args, **kwargs)

    return wrapper


# Vision needs readable labels and generous hit targets, hence the explicit sizing.
STYLE = """
<style>
  body { font-family: -apple-system, Arial, sans-serif; margin: 0; background: #f6f7f9; color: #16181d; }
  header { background: #1f2933; color: #fff; padding: 16px 24px; font-size: 20px; font-weight: 600; }
  nav { background: #fff; border-bottom: 1px solid #d8dce2; padding: 8px 24px; }
  nav a { display: inline-block; min-height: 36px; line-height: 36px; padding: 0 16px;
          margin-right: 8px; color: #1f2933; text-decoration: none; font-size: 16px;
          border: 1px solid #d8dce2; border-radius: 6px; background: #fff; }
  main { padding: 24px; max-width: 900px; }
  h1 { font-size: 24px; margin: 0 0 16px; }
  table { border-collapse: collapse; width: 100%; background: #fff; }
  th, td { text-align: left; padding: 12px 14px; border-bottom: 1px solid #e3e6ea; font-size: 15px; }
  th { background: #eef1f4; }
  td a { color: #1552b5; font-size: 15px; }
  .btn { display: inline-block; min-height: 40px; line-height: 40px; padding: 0 22px;
         font-size: 16px; font-weight: 600; border-radius: 6px; border: 1px solid #1f2933;
         background: #1f2933; color: #fff; cursor: pointer; text-decoration: none; margin-right: 12px; }
  .btn-danger { background: #b3261e; border-color: #b3261e; }
  .btn-warn { background: #b06000; border-color: #b06000; }
  .card { background: #fff; border: 1px solid #d8dce2; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
  label { display: block; margin: 14px 0 6px; font-size: 15px; font-weight: 600; }
  input { min-height: 38px; font-size: 16px; padding: 4px 10px; width: 280px;
          border: 1px solid #b6bcc5; border-radius: 6px; }
  .status { font-weight: 600; }
</style>
"""

NAV = """
<nav>
  <a href="/">Dashboard</a>
  <a href="/orders">Orders</a>
  <a href="/customers">Customers</a>
  <a href="/settings">Settings</a>
  <a href="/logout">Logout</a>
</nav>
"""


def page(title, body, nav=True):
    return (
        f"<!doctype html><html><head><title>{title}</title>{STYLE}</head><body>"
        f"<header>Cartographer Shop — Admin</header>{NAV if nav else ''}"
        f"<main>{body}</main></body></html>"
    )


def money(cents):
    return f"{cents / 100:.2f}"


@app.get("/health")
def health():
    return "ok"


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        if request.form.get("username") == "admin" and request.form.get("password") == "admin":
            session["user"] = "admin"
            return redirect(url_for("dashboard"))
        return page("Login", "<div class='card'><p>Invalid credentials.</p></div>", nav=False)
    body = """
    <div class="card">
      <h1>Sign in</h1>
      <form method="post">
        <label for="username">Username</label>
        <input id="username" name="username" value="">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" value="">
        <p><button class="btn" type="submit">Sign in</button></p>
      </form>
      <p>Use admin / admin.</p>
    </div>
    """
    return page("Login", body, nav=False)


@app.get("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.get("/")
@login_required
def dashboard():
    db = get_db()
    orders = db.execute("SELECT COUNT(*) c FROM orders").fetchone()["c"]
    customers = db.execute("SELECT COUNT(*) c FROM customers").fetchone()["c"]
    refunded = db.execute("SELECT COUNT(*) c FROM orders WHERE status='refunded'").fetchone()["c"]
    body = f"""
    <h1>Dashboard</h1>
    <div class="card">
      <p>Orders: <span class="status">{orders}</span></p>
      <p>Customers: <span class="status">{customers}</span></p>
      <p>Refunded orders: <span class="status">{refunded}</span></p>
    </div>
    <a class="btn" href="/orders">View orders</a>
    <a class="btn" href="/customers">View customers</a>
    """
    return page("Dashboard", body)


@app.get("/orders")
@login_required
def orders():
    db = get_db()
    rows = db.execute(
        "SELECT o.id, o.item, o.amount_cents, o.status, c.name "
        "FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.id"
    ).fetchall()
    trs = "".join(
        f"<tr><td>{r['id']}</td><td><a href='/orders/{r['id']}'>{r['item']}</a></td>"
        f"<td>{r['name']}</td><td>{money(r['amount_cents'])}</td>"
        f"<td class='status'>{r['status']}</td></tr>"
        for r in rows
    )
    body = f"""
    <h1>Orders</h1>
    <table>
      <tr><th>ID</th><th>Item</th><th>Customer</th><th>Amount</th><th>Status</th></tr>
      {trs}
    </table>
    """
    return page("Orders", body)


@app.get("/orders/<int:order_id>")
@login_required
def order_detail(order_id):
    db = get_db()
    r = db.execute(
        "SELECT o.id, o.item, o.amount_cents, o.status, c.name, c.email "
        "FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?",
        (order_id,),
    ).fetchone()
    if r is None:
        return page("Not found", "<div class='card'><p>Order not found.</p></div>"), 404
    body = f"""
    <h1>Order #{r['id']}</h1>
    <div class="card">
      <p>Item: <span class="status">{r['item']}</span></p>
      <p>Customer: {r['name']} ({r['email']})</p>
      <p>Amount: {money(r['amount_cents'])}</p>
      <p>Status: <span class="status">{r['status']}</span></p>
    </div>
    <form method="post" action="/orders/{r['id']}/refund" style="display:inline">
      <button class="btn btn-warn" type="submit">Refund order</button>
    </form>
    <form method="post" action="/orders/{r['id']}/delete" style="display:inline">
      <button class="btn btn-danger" type="submit">Delete order</button>
    </form>
    <a class="btn" href="/orders">Back to orders</a>
    """
    return page(f"Order {r['id']}", body)


@app.post("/orders/<int:order_id>/refund")
@login_required
def refund_order(order_id):
    get_db().execute("UPDATE orders SET status='refunded' WHERE id=?", (order_id,))
    return redirect(url_for("order_detail", order_id=order_id))


@app.post("/orders/<int:order_id>/delete")
@login_required
def delete_order(order_id):
    get_db().execute("DELETE FROM orders WHERE id=?", (order_id,))
    return redirect(url_for("orders"))


@app.get("/customers")
@login_required
def customers():
    rows = get_db().execute("SELECT id, name, email, city FROM customers ORDER BY id").fetchall()
    trs = "".join(
        f"<tr><td>{r['id']}</td><td><a href='/customers/{r['id']}'>{r['name']}</a></td>"
        f"<td>{r['email']}</td><td>{r['city']}</td></tr>"
        for r in rows
    )
    body = f"""
    <h1>Customers</h1>
    <table>
      <tr><th>ID</th><th>Name</th><th>Email</th><th>City</th></tr>
      {trs}
    </table>
    """
    return page("Customers", body)


@app.get("/customers/<int:customer_id>")
@login_required
def customer_detail(customer_id):
    db = get_db()
    r = db.execute("SELECT * FROM customers WHERE id=?", (customer_id,)).fetchone()
    if r is None:
        return page("Not found", "<div class='card'><p>Customer not found.</p></div>"), 404
    n = db.execute("SELECT COUNT(*) c FROM orders WHERE customer_id=?", (customer_id,)).fetchone()["c"]
    body = f"""
    <h1>{r['name']}</h1>
    <div class="card">
      <p>Email: {r['email']}</p>
      <p>City: {r['city']}</p>
      <p>Orders placed: <span class="status">{n}</span></p>
    </div>
    <a class="btn" href="/customers">Back to customers</a>
    """
    return page(r["name"], body)


@app.route("/settings", methods=["GET", "POST"])
@login_required
def settings():
    db = get_db()
    if request.method == "POST":
        db.execute(
            "UPDATE settings SET store_name=?, currency=? WHERE id=1",
            (request.form.get("store_name", ""), request.form.get("currency", "")),
        )
        return redirect(url_for("settings"))
    s = db.execute("SELECT store_name, currency FROM settings WHERE id=1").fetchone()
    body = f"""
    <h1>Settings</h1>
    <div class="card">
      <form method="post">
        <label for="store_name">Store name</label>
        <input id="store_name" name="store_name" value="{s['store_name']}">
        <label for="currency">Currency</label>
        <input id="currency" name="currency" value="{s['currency']}">
        <p><button class="btn" type="submit">Save settings</button></p>
      </form>
    </div>
    """
    return page("Settings", body)


if __name__ == "__main__":
    init_db()
    # Port 5000 in the sandbox (what carto.target.json expects). The override exists
    # only so this app can be smoke-tested on macOS, where AirPlay Receiver
    # (ControlCenter) already owns :5000 and answers 403 to everything.
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")), debug=False)
