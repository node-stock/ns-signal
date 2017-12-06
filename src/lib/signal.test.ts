import { Signal } from './signal';
import * as assert from 'power-assert';
import * as types from 'ns-types';


const signal = new Signal(require('config'));
const testGet5minData = async () => {
  const res = await signal.getCq5minData('6664');
  /* console.log(
    '%s\n...\n%s\n%s',
    JSON.stringify(res[0], null, 2),
    JSON.stringify(res[res.length - 1], null, 2),
    'length：' + res.length
  );*/
  assert(res);
  const resList = await signal.getCq5minData(['6553', '6664']);
  // console.log(resList);
  assert(resList.length === 2);
}

const testKDJ = async () => {
  const res = await signal.kdj(['6664', '1357']);
  assert(res);
}

describe('信号测试', () => {
  // it('获取5分钟数据', testGet5minData);
  it('测试KDJ', testKDJ);
});
