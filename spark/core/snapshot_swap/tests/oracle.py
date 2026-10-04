#!/usr/bin/env python3
"""Deliberately naive model of the snapshot-swap protocol and the oracle-table generator for tests.

The model is written the way the protocol is described in words, and in a DIFFERENT shape from the
Ada code: the Ada code keeps one (kind, seq) cell per slot; this model keeps three ROLE registers
(who is writing, which snapshot waits, what the consumer holds) and derives "Free" as "no role holds it".

    oracle.py --out DIR [--literal N]   write DIR/dfs_init.txt, dfs_near_max.txt, states.txt
    oracle.py --literal N               only run the self-checks (literal model enumeration, depth N)

Self-checks (always run, abort on failure):
  * every operation sequence of length <= N (literal enumeration, no memoisation) gives the same
    (status, slot, state) from the model as from the generated transition table;
  * on a bounded domain, the validity predicate equals "reachable from the initial state" (computed by
    breadth-first search with the model's own operations, Begin allowed to take any free slot).

What the files contain (all integers; kinds and statuses use the Ada enumeration positions):
  dfs_*.txt   transition table of the model over ALL states reachable by sequences of <= 10 operations
              from a start state (initial / 2 publishes below the sequence-number maximum);
  states.txt  the model's verdict on every state of a bounded domain (valid or not, and for valid
              states the result of each of the 5 operations), including states near 2**63 - 1.
"""
import sys

MAX_SEQ = 2 ** 63 - 1
SLOTS = 3
DEPTH = 10
KIND_NUM = {'F': 0, 'W': 1, 'P': 2, 'U': 3}  # Slot_Kind'Pos: Free, Writing, Published, In_Use
STATUS = ['Ok', 'Nothing_New', 'Already_Writing', 'Not_Writing', 'Already_In_Use', 'Not_In_Use',
          'Seq_Exhausted', 'Corrupt_State']
OPS = ['begin', 'publish', 'abort', 'acquire', 'release']  # Producer_Begin ... Consumer_Release


class Roles:
    """Who holds what.  A slot is free exactly when no role holds it."""

    def __init__(self, writer, waiting, reader, last):
        self.writer = writer    # slot the producer is filling, or None
        self.waiting = waiting  # (slot, seq): the newest published snapshot nobody took yet, or None
        self.reader = reader    # (slot, seq): the snapshot the consumer holds, or None
        self.last = last        # sequence number of the latest publish (0 = none yet)

    def free_slots(self):
        taken = {self.writer}
        taken |= {r[0] for r in (self.waiting, self.reader) if r is not None}
        return [s for s in range(SLOTS) if s not in taken]

    def begin(self):
        if self.writer is not None:
            return 'Already_Writing', None
        self.writer = self.free_slots()[0]      # the lowest free slot; there is always one
        return 'Ok', self.writer

    def publish(self):
        if self.writer is None:
            return 'Not_Writing', None
        if self.last == MAX_SEQ:
            return 'Seq_Exhausted', None
        self.last += 1
        slot, self.writer = self.writer, None
        self.waiting = (slot, self.last)        # replaces (supersedes) any older waiting snapshot
        return 'Ok', slot

    def abort(self):
        if self.writer is None:
            return 'Not_Writing', None
        slot, self.writer = self.writer, None
        return 'Ok', slot

    def acquire(self):
        if self.reader is not None:
            return 'Already_In_Use', None
        if self.waiting is None:
            return 'Nothing_New', None
        self.reader, self.waiting = self.waiting, None
        return 'Ok', self.reader[0]

    def release(self):
        if self.reader is None:
            return 'Not_In_Use', None
        slot, self.reader = self.reader[0], None
        return 'Ok', slot


# A state is ((kind, seq) * SLOTS, last) with kind in 'FWPU'.
INITIAL = (tuple(('F', 0) for _ in range(SLOTS)), 0)


def valid(state):
    """The states a correct run can produce, written as a plain list of rules."""
    slots, last = state
    for kind in 'WPU':
        if sum(1 for k, _ in slots if k == kind) > 1:
            return False                                   # at most one slot per role
    for kind, seq in slots:
        if kind in 'FW' and seq != 0:
            return False                                   # nothing published in it
    waiting = [q for k, q in slots if k == 'P']
    reader = [q for k, q in slots if k == 'U']
    if waiting and (waiting[0] != last or last == 0):
        return False                                       # the waiting snapshot is the newest
    if reader and not (1 <= reader[0] <= last):
        return False
    if reader and waiting and not reader[0] < waiting[0]:
        return False                                       # held one is older than the waiting one
    if reader and not waiting and reader[0] != last:
        return False                                       # nothing newer waits => held one is newest
    return True


def roles_of(state):
    slots, last = state
    writer = waiting = reader = None
    for i, (k, q) in enumerate(slots):
        if k == 'W':
            writer = i
        elif k == 'P':
            waiting = (i, q)
        elif k == 'U':
            reader = (i, q)
    return Roles(writer, waiting, reader, last)


def state_of(r):
    cells = [('F', 0)] * SLOTS
    if r.writer is not None:
        cells[r.writer] = ('W', 0)
    if r.waiting is not None:
        cells[r.waiting[0]] = ('P', r.waiting[1])
    if r.reader is not None:
        cells[r.reader[0]] = ('U', r.reader[1])
    return (tuple(cells), r.last)


def step(state, op):
    """(status, slot or None, new state) of one operation; invalid states are refused untouched."""
    if not valid(state):
        return 'Corrupt_State', None, state
    r = roles_of(state)
    status, slot = getattr(r, op)()
    return status, slot, state_of(r)


def flat(state):
    slots, last = state
    out = []
    for k, q in slots:
        out += [KIND_NUM[k], q]
    return out + [last]


def build_table(start, depth):
    """Transition table over every state reachable from `start` by <= depth operations."""
    index = {start: 0}
    states = [start]
    trans = {}
    frontier = [start]
    for _ in range(depth):          # frontier = states first reached after exactly d operations
        nxt = []
        for s in frontier:
            for op in range(len(OPS)):
                status, slot, ns = step(s, OPS[op])
                if ns not in index:
                    index[ns] = len(states)
                    states.append(ns)
                    nxt.append(ns)
                trans[(index[s], op)] = (status, slot, index[ns])
        frontier = nxt
    return states, trans


def literal_check(states, trans, depth):
    """Every operation sequence of length <= depth, enumerated one by one: model == table."""
    count = [0]

    def rec(state, idx, d):
        if d == depth:
            return
        for op in range(len(OPS)):
            status, slot, ns = step(state, OPS[op])
            t_status, t_slot, t_next = trans[(idx, op)]
            if (status, slot, ns) != (t_status, t_slot, states[t_next]):
                raise SystemExit('table disagrees with the model at depth %d op %s' % (d, OPS[op]))
            count[0] += 1
            rec(ns, t_next, d + 1)

    rec(states[0], 0, 0)
    expected = sum(len(OPS) ** k for k in range(1, depth + 1))
    if count[0] != expected:
        raise SystemExit('literal enumeration visited %d nodes, expected %d' % (count[0], expected))
    return count[0]


def write_table(path, states, trans, depth):
    with open(path, 'w') as f:
        f.write('DFS %d %d %d %d\n' % (SLOTS, depth, len(states), MAX_SEQ))
        for s in states:
            f.write('S ' + ' '.join(map(str, flat(s))) + '\n')
        for (i, op), (status, slot, nxt) in sorted(trans.items()):
            f.write('T %d %d %d %d %d\n' % (i, op, STATUS.index(status), -1 if slot is None else slot, nxt))


def domain_states():
    """Bounded domain: small sequence numbers and sequence numbers near the maximum."""
    cell_small = [(k, q) for k in 'FWPU' for q in range(5)]
    for last in range(5):
        for a in cell_small:
            for b in cell_small:
                for c in cell_small:
                    yield ((a, b, c), last), True
    top = [0, MAX_SEQ - 2, MAX_SEQ - 1, MAX_SEQ]
    cell_big = [(k, q) for k in 'FWPU' for q in top]
    for last in (MAX_SEQ - 2, MAX_SEQ - 1, MAX_SEQ):
        for a in cell_big:
            for b in cell_big:
                for c in cell_big:
                    yield ((a, b, c), last), False


def successors_any_free(state):
    """Successors when Begin may take ANY free slot (the Ada code takes the lowest, a refinement)."""
    out = [step(state, op)[2] for op in OPS[1:]]
    r = roles_of(state)
    if r.writer is None:
        for slot in r.free_slots():
            r = roles_of(state)
            r.writer = slot
            out.append(state_of(r))
    return out


def reachable_small(max_last):
    seen = {INITIAL}
    todo = [INITIAL]
    while todo:
        s = todo.pop()
        for ns in successors_any_free(s):
            if ns[1] <= max_last and ns not in seen:
                seen.add(ns)
                todo.append(ns)
    return seen


def write_states(path):
    reach = reachable_small(4)
    n_valid = n_total = 0
    with open(path, 'w') as f:
        for state, small in domain_states():
            v = valid(state)
            if small and v != (state in reach):
                raise SystemExit('validity predicate disagrees with reachability at %r' % (state,))
            n_total += 1
            n_valid += v
            line = ['V'] + [str(x) for x in flat(state)] + ['1' if v else '0']
            if v:
                for op in OPS:
                    status, slot, ns = step(state, op)
                    line += [str(STATUS.index(status)), str(-1 if slot is None else slot)]
                    line += [str(x) for x in flat(ns)]
            f.write(' '.join(line) + '\n')
    return n_total, n_valid, len(reach)


def main(argv):
    out = literal = None
    i = 1
    while i < len(argv):
        if argv[i] == '--out':
            out = argv[i + 1]
            i += 2
        elif argv[i] == '--literal':
            literal = int(argv[i + 1])
            i += 2
        else:
            raise SystemExit(__doc__)
    near_max = (tuple(('F', 0) for _ in range(SLOTS)), MAX_SEQ - 2)
    tables = [('dfs_init.txt', INITIAL), ('dfs_near_max.txt', near_max)]
    for name, start in tables:
        states, trans = build_table(start, DEPTH)
        print('%-17s %5d states, %5d transitions' % (name, len(states), len(trans)))
        if literal:
            n = literal_check(states, trans, literal)
            print('  literal enumeration, depth %d: %d steps, model == table' % (literal, n))
        if out:
            write_table('%s/%s' % (out, name), states, trans, DEPTH)
    if out:
        total, n_valid, n_reach = write_states('%s/states.txt' % out)
        print('states.txt        %5d domain states, %d valid (small-domain valid == reachable: %d states)'
              % (total, n_valid, n_reach))


if __name__ == '__main__':
    main(sys.argv)
