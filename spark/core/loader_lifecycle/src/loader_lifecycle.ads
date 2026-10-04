--  Loader_Lifecycle: what the UI shows while a replay loads, as two small proven state machines.
--    Loader_Lifecycle.Job     the load job: Idle -> Loading(phase, done, total) -> Ready, or Failed / Cancelled.
--    Loader_Lifecycle.Battle  one battle's status: Not_Opened -> Extracting -> Ready | Damaged, plus May_Draw.
--  This root package only holds the words both machines share.  README.md opens with the guarantees.
package Loader_Lifecycle
  with SPARK_Mode, Pure
is
   --  What happened to an event.  The state changes if and only if the result is Applied.
   type Outcome is
     (Applied,   --  the state changed
      Ignored,   --  stale or redundant (late message, already so): nothing to do, state unchanged
      Illegal);  --  refused because it breaks a rule (double load, impossible counters ...): state unchanged

   --  Why a job failed or a battle is damaged (failure-modes.md).
   type Error_Kind is
     (Not_A_Database,     --  not a SQLite file
      Truncated,          --  file shorter than its header claims / source ended early
      Wrong_Schema,       --  valid SQLite, not a recorder database
      Corrupt,            --  SQLite reported damaged pages
      Data_Implausible,   --  structurally valid, but the data fails the plausibility checks
      Storage_Quota,      --  OPFS / quota write failure
      Worker_Died,        --  a worker crashed or went silent (watchdog)
      Out_Of_Memory,      --  arena exhausted / memory.grow failed
      Internal,           --  anything else: a bug, reported rather than hidden
      Cancelled_By_User); --  a worker's wire code for "cancelled": always treated as the Cancel event

   --  The kinds a job can really fail with, and a battle be damaged by: a cancel is not a failure.
   subtype Failure_Kind is Error_Kind range Not_A_Database .. Internal;

end Loader_Lifecycle;
