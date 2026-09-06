import test from "node:test";
import assert from "node:assert/strict";
import { RunTracker } from "../dist/runs.js";
import { runTools } from "../dist/run-tools.js";
const result = () => ({ content: [{ type: "text", text: "Fixture result" }] });
function fixture() { const events=[]; const tracker=new RunTracker((type,detail,runId)=>events.push({type,detail:structuredClone(detail),runId})); const run=tracker.start("owner","Fixture task"); return {tracker,run,events}; }

test("acknowledgement is not implementation; task state is explicit", () => {
  const {tracker,run,events}=fixture(); const message=tracker.queue(run.id,"Keep the UI accessible","instruction-1");
  assert.equal(message.taskStatus,"queued"); tracker.attach(run.id,result());
  tracker.update("owner",run.id,"I will check contrast.","decision",[message.id]);
  assert.equal(message.state,"acknowledged"); assert.equal(message.taskStatus,"queued");
  assert.throws(()=>tracker.finish("owner",run.id,"completed","Not yet"),/STEERING_TASKS_UNFINISHED/);
  for(const status of ["in_progress","paused","queued","completed"]) tracker.update("owner",run.id,`Reported ${status}`,"progress",[],undefined,[{id:message.id,status}]);
  assert.equal(events.filter(e=>e.type==="steering.taskUpdated").length,4);
  tracker.update("owner",run.id,"Contrast verification complete.","progress",[],undefined,[],[{id:"contrast",title:"Verify accessible contrast",status:"completed",note:"Fixture check complete"}]);
  tracker.finish("owner",run.id,"completed","Contrast checked.");
});

test("all task updates are validated before acknowledgements or state mutate", () => {
  const {tracker,run,events}=fixture(); const message=tracker.queue(run.id,"One direction","instruction");
  tracker.attach(run.id,result()); const before=events.length;
  assert.throws(()=>tracker.update("owner",run.id,"Mixed update","progress",[message.id],undefined,[{id:message.id,status:"completed"},{id:"not-this-run",status:"completed"}]),/STEERING_NOT_ACKNOWLEDGED/);
  assert.equal(events.length,before); assert.equal(message.state,"returned"); assert.equal(message.taskStatus,"queued");
  assert.throws(()=>tracker.update("other",run.id,"Wrong session","progress",[],undefined,[{id:message.id,status:"completed"}]),/RUN_NOT_FOUND/);
});

test("open directions and todos are repeated even after delivery acknowledgement", () => {
  const {tracker,run}=fixture(); const message=tracker.queue(run.id,"Do not lose this instruction","instruction"); tracker.attach(run.id,result());
  tracker.update("owner",run.id,"Working on it","progress",[message.id],undefined,[{id:message.id,status:"in_progress"}], [{id:"tests",title:"Run all checks",status:"queued"}]);
  const receipt=tracker.attach(run.id,result()).content.at(-1).text;
  assert.match(receipt,/Do not lose this instruction/); assert.match(receipt,/Run all checks/); assert.match(receipt,/in_progress/);
});

test("todos update in place, survive steering, and prevent a false successful ending", () => {
  const {tracker,run,events}=fixture();
  tracker.update("owner",run.id,"Plan","plan",[],undefined,[],[{id:"build",title:"Build the UI",status:"in_progress"},{id:"verify",title:"Verify the build",status:"queued"}]);
  tracker.update("owner",run.id,"Pause to read steering","progress",[],undefined,[],[{id:"build",status:"paused"}]);
  assert.equal(run.todos.length,2); assert.equal(run.todos[0].title,"Build the UI");
  assert.throws(()=>tracker.finish("owner",run.id,"completed","Premature"),/RUN_TODOS_UNFINISHED/);
  tracker.update("owner",run.id,"Built and verified","progress",[],undefined,[],[{id:"build",status:"completed",note:"Build succeeded"},{id:"verify",status:"completed",note:"Checks passed"}]);
  assert.equal(run.todos.length,2); assert.equal(events.filter(e=>e.type==="run.todoUpdated").length,5);
  tracker.finish("owner",run.id,"completed","Finished");
});

test("cancelled work needs an explicit task outcome; failed runs retain unfinished work", () => {
  const {tracker,run}=fixture(); tracker.update("owner",run.id,"Plan","plan",[],undefined,[],[{id:"optional",title:"Optional animation",status:"queued"}]);
  tracker.update("owner",run.id,"Omitted by request","decision",[],undefined,[],[{id:"optional",status:"cancelled",note:"User chose a different scope"}]);
  tracker.finish("owner",run.id,"completed","Remaining work complete");
  const next=tracker.start("owner","Failure fixture");
  tracker.update("owner",next.id,"Checks queued","plan",[],undefined,[],[{id:"checks",title:"Checks",status:"queued"}]);
  tracker.finish("owner",next.id,"failed","Checks could not run");
  assert.equal(next.todos[0].status,"queued");
});

test("reporting schema accepts todos and steering tasks but rejects unsupported states", async () => {
  const {tracker,run}=fixture(); const update=runTools(tracker,()=>0).find(t=>t.tool.name==="run.update");
  const valid=await update.call({runId:run.id,summary:"Track tests",todos:[{id:"tests",title:"Run tests",status:"queued"}]},{runOwner:"owner"});
  assert.notEqual(valid.isError,true); assert.equal(run.todos[0].status,"queued");
  const invalid=await update.call({runId:run.id,summary:"Bad status",todos:[{id:"tests",status:"probably_done"}]},{runOwner:"owner"});
  assert.equal(invalid.isError,true); assert.equal(run.todos[0].status,"queued");
});
