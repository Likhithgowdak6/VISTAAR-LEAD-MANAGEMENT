"""
Pure domain logic, lifted from vistaar-payment-bot.

THE RULE FOR THIS PACKAGE: no Mongo, no FastAPI, no `app.db`, no I/O of any kind. Everything in
here is a function of its arguments. That is what made it liftable between two codebases with
different databases in the first place, and it is what keeps the money arithmetic testable
without a database.

Imports were rewritten (`vistaar.domain.shared.money` -> `app.domain.money`) and nothing else was
changed. The rules, the rounding, the GST split and the comments explaining them are the
originals, because this is tax arithmetic that was already correct and already tested - rewriting
it from a description would be inventing a second chance to get it wrong.
"""
