import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from './fold.mjs';
test('matching definitive identity cannot override exclusive contradiction',()=>{
 const match={definitiveMatch:true,definitiveContradiction:false,contradictions:[{type:'exclusive-key-conflict',strength:'strong'}],score:1000,strongest:'definitive'};
 assert.equal(decide(match).action,'review');
});
test('uncontested definitive identity may merge',()=>{
 assert.equal(decide({definitiveMatch:true,definitiveContradiction:false,contradictions:[]}).action,'merge');
});
