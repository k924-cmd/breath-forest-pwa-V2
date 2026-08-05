import test from "node:test";
import assert from "node:assert/strict";
import { localRoute } from "../src/conversation/router.js";

test("问候开头优先于通用知识兜底，但不破坏既有意图", () => {
  const cases = [
    // 任务要求：问候开头 + 介绍/闲聊 → chat
    ["你好，简单介绍一下自己", "chat"],
    ["你好", "chat"],
    ["您好，介绍一下自己", "chat"],
    ["嗨，简单介绍一下", "chat"],
    ["早上好，介绍一下自己", "chat"],
    ["hi 简单介绍下你", "chat"],
    // 无问候前缀的纯知识问题保持 knowledge_query
    ["介绍一下自己", "knowledge_query"],
    ["介绍一下空气净化器", "knowledge_query"],
    ["二氧化碳为什么会升高", "knowledge_query"],
    ["今天天气怎么样", "real_time_query"],
    ["室外 PM2.5 是多少", "real_time_query"],
    ["现在空气怎么样", "environment_query"],
    ["室外 PM2.5 是什么", "knowledge_query"],
    ["为什么下雨天要通风", "knowledge_query"],
    // 主题明确的知识问答即使带问候前缀仍为 knowledge_query
    ["你好，二氧化碳为什么会升高", "knowledge_query"],
    ["你好，介绍一下 PM2.5 知识", "knowledge_query"],
    // 既有意图保持不变
    ["我呼吸困难并且胸痛", "knowledge_query"],
    ["你好，现在空气怎么样", "environment_query"],
    ["你好，打开空气净化器", "device_control"],
  ];
  for (const [message, intent] of cases) {
    assert.equal(localRoute(message)?.intent, intent, message);
  }
});

test("英文与口语表达能识别为对应意图", () => {
  const cases = [
    // 英文问候 → chat
    ["good morning", "chat"],
    ["Good evening, nice to meet you", "chat"],
    ["good afternoon how are you", "chat"],
    // 英文设备控制 → device_control
    ["turn on the air purifier", "device_control"],
    ["Turn off the purifier", "device_control"],
    ["open the window", "device_control"],
    ["close the smart window", "device_control"],
    ["please turn on purifier", "device_control"],
    ["power on the purifier", "device_control"],
    // 英文空气查询 → environment_query
    ["what is the air quality", "environment_query"],
    ["how is the air", "environment_query"],
    ["what is the current AQI", "real_time_query"],
    ["what is the pm2.5 level now", "environment_query"],
    ["how is the indoor air today", "environment_query"],
    ["what is the co2 level", "environment_query"],
    ["temperature now", "environment_query"],
    ["humidity now", "environment_query"],
    // 口语化空气查询 → environment_query
    ["屋里空气怎么样", "environment_query"],
    ["房间空气好不好", "environment_query"],
    ["屋里空气干净吗", "environment_query"],
    // 英文知识概念问题仍为 knowledge_query
    ["what is PM2.5", "knowledge_query"],
    ["how does an air purifier work", "knowledge_query"],
    ["什么是空气净化器", "knowledge_query"],
    // 英文设备状态查询 → device_query
    ["is the purifier on", "device_query"],
    ["how is the window", "device_query"],
  ];
  for (const [message, intent] of cases) {
    assert.equal(localRoute(message)?.intent, intent, message);
  }
});

test("英文设备控制提取正确请求状态", () => {
  assert.equal(localRoute("turn on the air purifier").entities.requestedState, "on");
  assert.equal(localRoute("turn off the purifier").entities.requestedState, "off");
  assert.equal(localRoute("open the window").entities.requestedState, "on");
  assert.equal(localRoute("close the smart window").entities.requestedState, "off");
  assert.equal(localRoute("打开空气净化器").entities.requestedState, "on");
  assert.equal(localRoute("关闭空气净化器").entities.requestedState, "off");
});

test("英文空气查询提取对应指标", () => {
  assert.deepEqual(localRoute("what is the pm2.5 level now").entities.metrics, ["pm25"]);
  assert.deepEqual(localRoute("what is the pm2.5 and co2 level").entities.metrics, ["pm25", "co2"]);
  assert.deepEqual(localRoute("what is the co2 level").entities.metrics, ["co2"]);
  assert.deepEqual(localRoute("temperature now").entities.metrics, ["temperature"]);
  assert.deepEqual(localRoute("温度现在多少").entities.metrics, ["temperature"]);
});
