--  Every numeric limit the system depends on, named once (docs/limits.md has the source of each).
--  Units take sizes/counts/ids as the subtypes below and return an explicit Limit_Exceeded result for anything outside.
with Interfaces;

package Limits with SPARK_Mode, Pure is

   --  SQLite file format and compile-time defaults (https://www.sqlite.org/limits.html, /fileformat.html)
   Header_Bytes          : constant := 100;
   Min_Page_Size         : constant := 512;
   Max_Page_Size         : constant := 65_536;
   Max_Page_Count        : constant := 4_294_967_294;
   Max_Db_Bytes          : constant := Max_Page_Size * Max_Page_Count;
   Max_Value_Length      : constant := 1_000_000_000;   --  string / BLOB / row
   Max_Sql_Length        : constant := 1_000_000_000;
   Max_Columns           : constant := 2_000;
   Max_Attached          : constant := 10;
   Max_Variables         : constant := 32_766;

   --  WebAssembly / browser
   Wasm32_Max_Memory     : constant := 2**32;           --  65,536 pages of 64 KiB; pointers are 32-bit
   Configured_Max_Memory : constant := 2**31;           --  owner: wasm32 first, 2 GiB
   Max_Buffer_Bytes      : constant := 2**31 - 1;       --  keeps 32-bit offsets sign-safe
   Js_Max_Safe_Integer   : constant := 2**53 - 1;       --  exact integers crossing the JS boundary
   Max_Read_Chunk        : constant := 16 * 2**20;
   Min_Threads           : constant := 1;
   Max_Threads           : constant := 8;

   --  Recorder / domain (frozen recorder, old engine constants)
   Max_Agent_Id          : constant := 1_024;           --  MAX_AGENT_SLOTS = 1025

   --  Owner / design limits
   Max_Identifier_Bytes  : constant := 128;
   Max_Name_Bytes        : constant := 64;

   --  The largest source file we accept: the database size limit (which is also exactly representable).
   Max_Source_File_Bytes : constant := Max_Db_Bytes;

   subtype File_Bytes    is Long_Long_Integer range 0 .. Max_Source_File_Bytes;
   subtype Page_Size     is Integer range Min_Page_Size .. Max_Page_Size;
   subtype Page_Count    is Long_Long_Integer range 0 .. Max_Page_Count;
   subtype Buffer_Length is Integer range 0 .. Max_Buffer_Bytes;
   subtype Agent_Id      is Integer range 0 .. Max_Agent_Id;
   subtype Thread_Count  is Integer range Min_Threads .. Max_Threads;
   subtype U64           is Interfaces.Unsigned_64;

   --  The relationships between the limits, proved (not tested):
   function Consistent return Boolean is
     (Max_Db_Bytes = Max_Page_Size * Max_Page_Count                  --  derived exactly
      and Max_Db_Bytes <= Js_Max_Safe_Integer                        --  a file size is an exact JS Number
      and Max_Db_Bytes <= Long_Long_Integer'Last                     --  and fits signed 64-bit
      and Max_Page_Count * Max_Page_Size / Max_Page_Size = Max_Page_Count
      and Configured_Max_Memory <= Wasm32_Max_Memory                 --  configured memory fits wasm32
      and Max_Buffer_Bytes < Configured_Max_Memory                   --  every buffer length fits the configured memory
      and Max_Buffer_Bytes <= Integer'Last                           --  and a 32-bit signed offset
      and Max_Read_Chunk <= Max_Buffer_Bytes                         --  a read chunk is a valid buffer
      and Max_Identifier_Bytes <= Max_Value_Length                   --  design limits sit inside SQLite's
      and Max_Name_Bytes <= Max_Identifier_Bytes
      and Max_Attached >= 2)                                         --  main + one attached source
   with Post => Consistent'Result;

end Limits;
