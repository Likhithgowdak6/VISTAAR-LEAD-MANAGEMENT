"""Financial safety indexes shared by HTTP and worker startup. Fail closed on any error."""
from app.invoices_repository import ensure_invoice_indexes
from app.payments_repository import ensure_payment_indexes
from app.payment_links_repository import ensure_razorpay_indexes
from app.invoice_payment_chase import ensure_payment_chase_indexes
from app.recurring_invoices_repository import ensure_recurring_indexes


async def ensure_billing_indexes(database=None):
    await ensure_invoice_indexes(database)
    await ensure_payment_indexes(database)
    await ensure_razorpay_indexes(database)
    await ensure_payment_chase_indexes(database)
    await ensure_recurring_indexes(database)
