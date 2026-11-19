"""
Recurring-invoice calendar arithmetic.

THE CASES THAT ACTUALLY BREAK THIS are month ends and leap years, so most of the file is those.
A template billed on the 31st must bill on 28 February - not skip the month, not roll into
1 March, and not be permanently shortened to the 28th afterwards.

The second theme is DRIFT. The source project advanced the schedule from `today`, so a job that
ran late moved every future invoice later with it. Advancing from the occurrence being generated
is what keeps a template billed on the 1st billed on the 1st a decade from now, and these tests
pin that over long runs rather than a single step.
"""

from __future__ import annotations

from datetime import date

import pytest

from app.domain.recurrence import (
    ALLOWED_INTERVAL_MONTHS,
    add_months,
    clamp_day,
    next_occurrence,
    occurrence_on_or_after,
    period_key,
    validate_schedule,
)


class TestClampDay:
    @pytest.mark.parametrize(
        "year,month,day,expected",
        [
            (2026, 1, 31, 31),   # January has 31
            (2026, 2, 31, 28),   # February, common year
            (2028, 2, 31, 29),   # February, leap year
            (2026, 4, 31, 30),   # April has 30
            (2026, 2, 15, 15),   # inside the month, untouched
        ],
    )
    def test_clamps_to_the_month_length(self, year, month, day, expected):
        assert clamp_day(year, month, day) == expected

    def test_leap_year_rules_are_the_calendar_s_not_ours(self):
        # 2100 is NOT a leap year - divisible by 100 but not 400. A hand-rolled `% 4` would
        # get this wrong, which is why the stdlib does it.
        assert clamp_day(2100, 2, 31) == 28
        assert clamp_day(2000, 2, 31) == 29


class TestAddMonths:
    @pytest.mark.parametrize(
        "year,month,delta,expected",
        [
            (2026, 1, 1, (2026, 2)),
            (2026, 12, 1, (2027, 1)),     # wraps the year
            (2026, 11, 3, (2027, 2)),     # wraps mid-quarter
            (2026, 1, 12, (2027, 1)),     # annual
            (2026, 6, 0, (2026, 6)),
        ],
    )
    def test_shifts_and_wraps(self, year, month, delta, expected):
        assert add_months(year, month, delta) == expected


class TestFirstOccurrence:
    def test_this_month_when_the_day_is_still_ahead(self):
        # Set up on the 10th, billed on the 20th: the first one is this month.
        assert occurrence_on_or_after(day_of_month=20, after=date(2026, 11, 10)) == date(2026, 11, 20)

    def test_today_counts_as_on_or_after(self):
        assert occurrence_on_or_after(day_of_month=10, after=date(2026, 11, 10)) == date(2026, 11, 10)

    def test_next_month_when_the_day_has_passed(self):
        assert occurrence_on_or_after(day_of_month=5, after=date(2026, 11, 10)) == date(2026, 12, 5)

    def test_clamps_into_a_short_month(self):
        # Billed on the 31st, set up on 30 January: the first one is 31 January.
        assert occurrence_on_or_after(day_of_month=31, after=date(2026, 1, 30)) == date(2026, 1, 31)

        # Set up on 1 February: clamped to the 28th rather than skipping to March.
        assert occurrence_on_or_after(day_of_month=31, after=date(2026, 2, 1)) == date(2026, 2, 28)

    def test_wraps_the_year(self):
        assert occurrence_on_or_after(day_of_month=5, after=date(2026, 12, 10)) == date(2027, 1, 5)


class TestNextOccurrence:
    def test_monthly(self):
        assert next_occurrence(
            day_of_month=15, interval_months=1, previous=date(2026, 11, 15)
        ) == date(2026, 12, 15)

    def test_quarterly(self):
        assert next_occurrence(
            day_of_month=1, interval_months=3, previous=date(2026, 11, 1)
        ) == date(2027, 2, 1)

    def test_annual(self):
        assert next_occurrence(
            day_of_month=1, interval_months=12, previous=date(2026, 3, 1)
        ) == date(2027, 3, 1)

    def test_a_clamped_month_does_not_shorten_the_schedule(self):
        """
        THE ONE THAT CATCHES A NAIVE IMPLEMENTATION.

        A template on the 31st bills 28 February. Advancing from `previous.day` would make March
        the 28th, then April the 28th, and the template would be permanently moved. The day comes
        from the TEMPLATE, not from the clamped date.
        """
        february = next_occurrence(day_of_month=31, interval_months=1, previous=date(2026, 1, 31))
        assert february == date(2026, 2, 28)

        march = next_occurrence(day_of_month=31, interval_months=1, previous=february)
        assert march == date(2026, 3, 31)

    def test_leap_day_template_survives_a_common_year(self):
        # Billed on the 29th. 2028 is a leap year, 2029 is not.
        assert next_occurrence(
            day_of_month=29, interval_months=12, previous=date(2028, 2, 29)
        ) == date(2029, 2, 28)

    def test_does_not_drift_over_a_decade(self):
        """
        The schedule is computed from the occurrence, so 120 monthly steps from 1 January land
        on the 1st every time - no accumulated slip.
        """
        current = date(2026, 1, 1)

        for _ in range(120):
            current = next_occurrence(day_of_month=1, interval_months=1, previous=current)
            assert current.day == 1

        assert current == date(2036, 1, 1)

    def test_a_month_end_template_returns_to_month_end_every_time(self):
        current = date(2026, 1, 31)
        seen = []

        for _ in range(12):
            current = next_occurrence(day_of_month=31, interval_months=1, previous=current)
            seen.append((current.month, current.day))

        # Every month lands on its own last day.
        assert seen == [
            (2, 28), (3, 31), (4, 30), (5, 31), (6, 30), (7, 31),
            (8, 31), (9, 30), (10, 31), (11, 30), (12, 31), (1, 31),
        ]


class TestPeriodKey:
    """
    The idempotency key. It must be reproducible from the occurrence alone, so regenerating
    after a crash collides with the first attempt instead of inventing a new period.
    """

    def test_monthly(self):
        assert period_key(date(2026, 11, 5), interval_months=1) == "2026-11"

    def test_annual(self):
        assert period_key(date(2026, 3, 1), interval_months=12) == "2026"

    @pytest.mark.parametrize(
        "month,expected",
        [(1, "2026-Q1"), (3, "2026-Q1"), (4, "2026-Q2"), (12, "2026-Q4")],
    )
    def test_quarterly_is_numbered_from_january(self, month, expected):
        # Not from whenever the template started, so the label means the same thing for every
        # template in the workspace.
        assert period_key(date(2026, month, 1), interval_months=3) == expected

    @pytest.mark.parametrize("month,expected", [(1, "2026-H1"), (6, "2026-H1"), (7, "2026-H2")])
    def test_half_yearly(self, month, expected):
        assert period_key(date(2026, month, 1), interval_months=6) == expected

    def test_is_stable_for_every_day_in_a_period(self):
        # Two runs of one month, whatever day they happen on, produce one key - so a late run
        # cannot create a second invoice for the same month.
        assert period_key(date(2026, 11, 1), interval_months=1) == period_key(
            date(2026, 11, 30), interval_months=1
        )


class TestValidateSchedule:
    @pytest.mark.parametrize("interval", ALLOWED_INTERVAL_MONTHS)
    def test_accepts_allowed_intervals(self, interval):
        validate_schedule(day_of_month=1, interval_months=interval)

    @pytest.mark.parametrize("interval", [0, 4, 5, 7, 13, -1])
    def test_rejects_other_intervals(self, interval):
        with pytest.raises(ValueError, match="Bill every"):
            validate_schedule(day_of_month=1, interval_months=interval)

    @pytest.mark.parametrize("day", [0, 32, -1])
    def test_rejects_an_impossible_billing_day(self, day):
        with pytest.raises(ValueError, match="billing day"):
            validate_schedule(day_of_month=day, interval_months=1)

    def test_accepts_the_thirty_first(self):
        # Legal, and clamped per month rather than refused.
        validate_schedule(day_of_month=31, interval_months=1)
