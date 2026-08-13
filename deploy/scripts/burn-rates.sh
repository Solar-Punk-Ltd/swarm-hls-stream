# What a minute of publishing costs each node, in PLUR. 1 BZZ = 10^16 PLUR.
#
# ⛔⛔⛔ THIS FILE EXISTS BECAUSE THE NUMBER WAS WRONG IN THREE PLACES AT ONCE.
#
# On 2026-08-13 three scripts carried four different values between them: `viewer-arms.sh` at
# 0.0130/0.0107, `sweep-interleaved.sh` at 0.0437/0.0355, `phase06-light-vs-ultralight.sh` at
# 0.0179/0.0102, and a comment in phase06 quoting a fourth. Only the first had been measured. A
# constant corrected where somebody happened to be looking, and left everywhere else.
#
# `deploy/test/burnRates.test.js` refuses a fifth: no script may define its own.
#
# ## What it is measured on
#
# Every sitting that bracketed itself with a node-metrics snapshot pair, priced off its own
# chequebook readings rather than off a difference between windows:
#
#   sitting                             minutes   uploader BZZ/hr   gateway BZZ/hr
#   arms, EIGHT broadcasts                 48.1              0.70             0.58
#   soak 0.5s GOP, one broadcast          118.9              0.78             0.64
#   soak 2.0s GOP, one broadcast          238.8              0.71             0.59
#
# ⭐⭐⭐ The eight-broadcast sitting sits INSIDE the range of the single-broadcast soaks, which is why
# there is no per-broadcast setup term. See `docs/bench/interleaved-gop-arms-2026-08-12.md`.
#
# ⭐ The 0.5s soak also replicates internally: four 30-minute windows at 0.80, 0.75, 0.79, 0.80. A
# rate measured over a long continuous window and replicated inside it is the only kind that has
# survived here. Four earlier constants were each defended with arithmetic and each was wrong.
#
# The values below are the highest measured, so the 140% margin sits on top of a real peak rather
# than rescuing a constant that is already too low.
#
# ⚠️ 720p 2500 kbps. 1080p costs roughly 2.3x and every caller takes an override for it.
UPLOADER_BURN_PLUR_PER_MIN="${UPLOADER_BURN_PLUR_PER_MIN:-130000000000000}"
GATEWAY_BURN_PLUR_PER_MIN="${GATEWAY_BURN_PLUR_PER_MIN:-107000000000000}"

# ⛔⛔⛔ MEASURED AT ZERO, having been 0.15/0.12 BZZ for a day.
#
# The premise was that a broadcast costs something to start, fitted from the arms sitting appearing
# to read 2.06 BZZ/hr against the soak's 0.78. It reads 0.70. Each of that sitting's six counted arms
# contains exactly ONE broadcast start, so subtracting the marginal rate leaves the setup term alone:
# -0.0089 to +0.0030 BZZ, five of six negative, against a constant of 0.15.
#
# ⭐ Kept as a knob rather than deleted, because a fixed cost per broadcast is a plausible thing to
# find on another profile. It is not present on this one, and a sweep of short arms is not expensive.
UPLOADER_SETUP_PLUR="${UPLOADER_SETUP_PLUR:-0}"
GATEWAY_SETUP_PLUR="${GATEWAY_SETUP_PLUR:-0}"

# Headroom over the straight-line estimate, and the only place safety belongs. ⚠️ Conservatism
# applied twice is its own fault: on 2026-08-05 a constant 1.5x high plus this margin refused 60
# affordable minutes and led to asking the owner for a deposit that was not needed.
FUNDS_MARGIN_PERCENT="${FUNDS_MARGIN_PERCENT:-140}"
