/// Retest after RoomPlan configures the shared ARSession. A previous successful
/// relocalization cannot authorize recording after the coordinate frame changes.
struct AlignmentContinuity {
    private(set) var awaitingConfirmation = false
    private(set) var invalidated = false
    private var good = 0
    private var bad = 0
    mutating func beginConfirmation(required: Bool) {
        awaitingConfirmation = required; invalidated = false; good = 0; bad = 0
    }
    mutating func observe(known: Int, matches: Bool, mismatch: Bool) {
        guard known >= 50, !invalidated else { return }
        if mismatch { bad += 1; good = 0 }
        else if matches { good += 1; bad = 0 }
        else { good = 0; bad = 0 }
        if awaitingConfirmation && good >= 3 { awaitingConfirmation = false }
        if bad >= 3 { invalidated = true; awaitingConfirmation = false }
    }
}
