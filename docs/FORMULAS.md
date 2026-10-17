# Formulas

Formulas compute new values from the metrics you track. You use them in two places:

- **Formula metrics**, such as `bmi = weight / (height / 100) ^ 2`, which you can then use in other formulas and charts.
- **Chart series**: every line, bar or candle of a chart is a formula, even if it is just a metric name like `weight`.

All examples on this page use made-up metrics: `weight` (kg, entered most days), `height` (cm, entered once in a while), `bank`, `stocks` and `savings` (account balances), `steps`, `sleep`, `monthly_expenses` and `monthly_balance` (entered once a month, on the 1st), and `lifetime_need` and `monthly_need` (plan parameters that change rarely).

## A few examples

| Formula | What it gives |
| --- | --- |
| `weight / (height / 100) ^ 2` | Body mass index on each day you weighed yourself |
| `ma(weight, 7)` | 7-day moving average of your weight |
| `bank + fill(stocks, 0) + fill(savings, 0)` | Net worth, counting investments as 0 before they existed |
| `pct(stocks, 1000)` | Gain or loss of an investment of 1000, in percent |
| `last(networth) - first(networth)` | How much net worth changed (per year, in a yearly bar chart) |
| `median(monthly_expenses)` | Typical monthly expenses |
| `monthly(weight, "mean")` | Average weight of each month |
| `if(sleep < 6, 1, 0)` | 1 on short nights, 0 otherwise |

## Three kinds of values

**Series.** A metric is a series: a list of dated values. Days without an entry have no value. A metric can be set to *hold its value* (the "step" fill setting): then each value holds until the next entry, and the last one holds from then on. Balances, height or a monthly budget work like that; your weight usually does not. You can switch a series between the two behaviours in a formula with `fill(x)` and `nofill(x)`.

**Numbers.** `75`, `first(weight)` or `median(monthly_expenses)` are single numbers. When there is no data to compute a number from (for example the average of a month with no entries), the result is *no data*, shown as a gap, and any calculation with it also gives no data.

**Date functions.** `since("2021-03-01")` has a value on every day: the number of days since that date. It is useful in plans, for example to subtract a monthly cost for every month that passed.

## Writing formulas

- **Numbers**: `12`, `3.5`, `.5`, `1e3` (1000). Use `_` to group digits: `1_250_000`.
- **Names** of metrics and formulas are written as they are, like `weight` or `monthly_need`. Upper and lower case matter.
- **Text in double quotes** is only used for dates, always written `"YYYY-MM-DD"` (like `"2021-03-01"`), and for reducer names (like `"median"`).
- **Functions** are called with parentheses: `rolling(weight, 7, "median")`. The full list is at the end of this page.
- **Operators**, from the loosest to the tightest:

| Operators | Meaning |
| --- | --- |
| `<`  `<=`  `>`  `>=`  `==`  `!=` | Comparisons: 1 when true, 0 when false |
| `+`  `-` | Addition, subtraction |
| `*`  `/` | Multiplication, division |
| `-x` | Negation |
| `^` | Power |

So `1 + 2 * 3` is 7, and `-2 ^ 2` is -4 (the power applies before the minus sign). Powers group from the right: `2 ^ 3 ^ 2` is `2 ^ 9`. Use parentheses whenever in doubt. Comparisons cannot be chained: instead of `60 < weight < 80`, write `(60 < weight) * (weight < 80)`, which is 1 when both are true.

When something is wrong, the editor underlines the exact place and explains the problem, for example `Unknown name "wieght". Did you mean "weight"?` or `Expected ")" to close "rolling("`.

## How series are combined

When a formula combines several series, such as `weight / (height / 100) ^ 2`, the values have to be matched day by day. The rules are:

1. **A number with a series** applies to every value of the series. `weight * 2` doubles each weight.
2. **Two series that don't hold their values** are only combined on the days both have a value. If you weighed yourself on Monday and Wednesday and measured your waist on Wednesday and Friday, `weight / waist` only has a value on Wednesday.
3. **A series with one that holds its value** is computed on each day of the first, using the value in force that day. `weight / (height / 100) ^ 2` gives a BMI for every weighing day, each with the height that was valid then. Days before the first height entry have no value.
4. **Two series that hold their values** give a series that also holds its value, changing on any day either of them changes. `bank + stocks` only starts once both exist; `bank + fill(stocks, 0)` counts the investment as 0 before its first entry.
5. **A series with a date function** is computed on the days of the series. If that series holds its value, those are only the days it *changes*. To get a value on every day, expand it with `daily(x)`:

   ```
   lifetime_need - since("2021-03-01") * daily(monthly_need) / 30.4375
   ```

   Without `daily`, this would only have values on the few days `monthly_need` was changed.

The same rules apply to functions that take several series, like `if(c, a, b)`, `min(a, b)` and `clamp(x, lo, hi)`: each day needs a value in all of them.

A result that cannot be computed is left out instead of breaking the whole series: dividing by zero, the square root of a negative number, and so on. So `bank / monthly_expenses` simply skips months with zero expenses.

## Charts, periods and buckets

Charts evaluate the same formulas, but sometimes on a part of your history only. This happens when a chart is filtered to a period (for example one diet, or "each period" for one small chart per period), and for every bar of a bucket or period chart (one bar per month, per year, per place you lived in…).

In those cases **every metric is first cut to that range**, and the formula is evaluated on what remains:

- A metric that holds its value starts the range with the value it had on the first day, so `last(networth) - first(networth)` in a yearly bar chart is the change over each year, starting from the value on January 1.
- `pct(weight)` starts at 0 at the beginning of each period.
- Windows such as `ma(weight, 7)` and `change(weight)` start again at the beginning of each range: they do not see the data before it.
- Date functions are not affected: `since("2021-03-01")` still counts from that date.
- `since(lifetime_need)` counts from the first entry of `lifetime_need` in your whole history, even in a filtered chart. Use it when a plan starts on the day its first parameter was entered.

How a chart uses the result:

- **Date axis**: series are drawn as they are. A single number is drawn as a horizontal line across the chart, and a date function as a value on every day.
- **Days elapsed**: each series starts at day 1 on its own first value, so different periods or investments can be compared side by side.
- **Buckets and periods** (bars, lines over categories): each category shows one number. A formula that gives a single number, like `median(monthly_expenses)`, is shown as is. A series is reduced to one number with the series' *reducer* (`last` by default, `sum` for waterfalls). A date function shows its value on the last day of the category.
- **Candles** show, for each category, the first, last, lowest and highest value of the series.
- **Waterfall** uses the first series only: each category adds its value to a running total.

### Reducers

Reducers combine the values of a bucket, a period or a window into one number. They are written in quotes, like `"median"`.

| Reducer | Result |
| --- | --- |
| `last` | The last value |
| `first` | The first value |
| `sum` | The total |
| `mean` | The average |
| `median` | The middle value |
| `min` | The smallest value |
| `max` | The largest value |
| `delta` | Last value minus first value |
| `count` | How many values there are |

For a series that holds its value, the value in force at the start of a bucket counts as its first value. That makes `delta` the change over the bucket and `first` the opening value, but it also means `sum` and `count` include that carried value: use them with metrics that don't hold their values, like monthly expenses.

## Recipes

**Net worth.** `bank + fill(stocks, 0) + fill(savings, 0)`

**Yearly surplus.** A bar chart with one bucket per year and the series `last(networth) - first(networth)`.

**Financial independence level.** How much of a lifetime need is already covered, where the need shrinks by a monthly cost for every month that passes since the plan started:

```
networth / (lifetime_need - since(lifetime_need) * daily(monthly_need) / 30.4375) * 100
```

**Weekly change in weight.** `weight - shift(weight, 7)` (needs a weighing exactly one week earlier), or `change(weekly(weight, "mean"))` for the change between weekly averages.

**Savings rate per place of residence.** A chart with one category per period of a "places" period set and the series `median(monthly_balance) / median(monthly_expenses)`.

## Functions

The arguments called `x` take a metric, a formula or any expression. Arguments followed by `?` can be left out; arguments with `=` show their default value.

### Math

#### `abs(x)`

Absolute value: the value without its minus sign.

Example: `abs(change(weight))`

#### `sqrt(x)`

Square root. Negative values have no result.

Example: `sqrt(steps)`

#### `ln(x)`

Natural logarithm. Zero and negative values have no result.

Example: `ln(networth)`

#### `log10(x)`

Base-10 logarithm. Zero and negative values have no result.

Example: `log10(networth)`

#### `exp(x)`

The number e raised to the power x.

Example: `exp(0.05 * days(bank) / 365)`

#### `floor(x)`

Rounds down to a whole number.

Example: `floor(weight)`

#### `ceil(x)`

Rounds up to a whole number.

Example: `ceil(sleep)`

#### `sign(x)`

-1 for negative values, 1 for positive values and 0 for zero.

Example: `sign(change(weight))`

#### `round(x, digits = 0)`

Rounds to the given number of decimals; halves round away from zero. Negative digits round to tens, hundreds…

Example: `round(bmi, 1)`

#### `clamp(x, lo, hi)`

Limits x to the range from lo to hi.

Example: `clamp(sleep, 4, 10)`

### Aggregates: one number from a series

#### `first(x)`

The first value of a series.

Example: `first(weight)`

#### `last(x)`

The most recent value of a series.

Example: `last(bank)`

#### `min(x) or min(a, b, …)`

With one argument, the smallest value of a series. With two or more, the smallest of the arguments on each day, e.g. min(bank, 5000).

Example: `min(weight)`

#### `max(x) or max(a, b, …)`

With one argument, the largest value of a series. With two or more, the largest of the arguments on each day, e.g. max(bank, 5000).

Example: `max(bank, 0)`

#### `mean(x)`

The average of the values of a series.

Example: `mean(sleep)`

#### `avg(x)`

Same as mean.

Example: `avg(sleep)`

#### `median(x)`

The middle value of a series: half of the values are above it, half below.

Example: `median(monthly_expenses)`

#### `sum(x)`

The total of the values of a series.

Example: `sum(monthly_balance)`

#### `count(x)`

How many values a series has.

Example: `count(weight)`

#### `stdev(x)`

Sample standard deviation: how spread out the values are.

Example: `stdev(weight)`

#### `delta(x)`

Change from the first to the last value, the same as last(x) - first(x).

Example: `delta(networth)`

### Transforms

#### `fill(x, before?)`

Makes x a step series: each value holds until the next one, and the last one holds from then on. The optional second argument is the value before the first point, e.g. 0 for an account that did not exist yet.

Example: `bank + fill(stocks, 0)`

#### `nofill(x)`

The opposite of fill: values no longer hold between points, so gaps stay gaps.

Example: `nofill(bank)`

#### `rolling(x, n, reducer = "mean")`

For each point, combines the points of the last n calendar days (that day included) with the reducer: mean, median, sum, min, max, first, last, delta or count.

Example: `rolling(weight, 7, "median")`

#### `ma(x, n)`

Moving average over the last n calendar days, the same as rolling(x, n).

Example: `ma(weight, 7)`

#### `ema(x, n)`

Exponential moving average over the points, with smoothing factor 2 / (n + 1): recent values weigh more than old ones.

Example: `ema(weight, 10)`

#### `pct(x, base?)`

Percent difference from a base: (x - base) / base * 100. Without a base, the first value of x is used (the first one in the visible range when a chart is filtered).

Example: `pct(stocks, 1000)`

#### `rebase(x, to = 100)`

Scales x so that its first value becomes `to` (100 by default), to compare how different things grow.

Example: `rebase(stocks)`

#### `change(x)`

Difference from the previous point. The first point has no previous one, so it is left out.

Example: `change(weight)`

#### `diff(x)`

Same as change.

Example: `diff(bank)`

#### `pctchange(x)`

Percent change from the previous point: (x - previous) / |previous| * 100.

Example: `pctchange(networth)`

#### `cumsum(x)`

Running total of the values.

Example: `cumsum(monthly_balance)`

### Time

#### `daily(x)`

One value per day, each day holding the latest value, from the first point until today (or until the end of the range when a chart is filtered).

Example: `daily(monthly_need)`

#### `interp(x)`

Fills every day between two points with a straight line from one to the next.

Example: `interp(weight)`

#### `days(x)`

On each point of x, the number of days since its first point (0 on the first point).

Example: `days(weight)`

#### `since("YYYY-MM-DD") or since(x)`

Days elapsed since a date, defined on every day (negative before it). Given a series instead, counts from its first point; that start never moves, even when a chart is filtered.

Example: `since("2021-03-01")`

#### `between(x, "from", "to"?)`

Keeps the points between two dates, both included. Without the end date, keeps everything from the start date on. A step series gets a point on the start date with the value in force then.

Example: `between(weight, "2024-01-01", "2024-06-30")`

#### `shift(x, n)`

Moves every point n days later; a negative n moves them earlier.

Example: `weight - shift(weight, 7)`

#### `weekly(x, reducer = "last")`

One value per week (Monday to Sunday), dated on its Monday, combining the points inside it with the reducer (last, first, sum, mean, median, min, max, delta or count). For a step series, the value in force when the period starts counts as its first point.

Example: `weekly(weight, "mean")`

#### `monthly(x, reducer = "last")`

One value per calendar month, dated on the 1st, combining the points inside it with the reducer (last, first, sum, mean, median, min, max, delta or count). For a step series, the value in force when the period starts counts as its first point.

Example: `monthly(bank)`

#### `quarterly(x, reducer = "last")`

One value per quarter, dated on its first day, combining the points inside it with the reducer (last, first, sum, mean, median, min, max, delta or count). For a step series, the value in force when the period starts counts as its first point.

Example: `quarterly(networth, "delta")`

#### `yearly(x, reducer = "last")`

One value per calendar year, dated on January 1, combining the points inside it with the reducer (last, first, sum, mean, median, min, max, delta or count). For a step series, the value in force when the period starts counts as its first point.

Example: `yearly(monthly_expenses, "sum")`

### Logic

#### `if(condition, a, b)`

a where the condition is true (not 0) and b elsewhere. Comparisons such as weight > 80 give 1 when true and 0 when false.

Example: `if(weight > 80, weight - 80, 0)`
