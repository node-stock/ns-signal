import { Signal, IKdjOutput } from './signal';
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
  const symbolType = types.SymbolType.stock;
  const min5 = types.CandlestickUnit.Min15;
  const res = await signal.kdj(['6664', '1357'], symbolType, [min5]);
  console.log(res)
  assert(res);
}

const testBitcoinKDJ = async () => {
  const symbolType = types.SymbolType.cryptocoin;
  const min5 = types.CandlestickUnit.Min15;
  const res = await signal.kdj(types.Pair.BTC_JPY, symbolType, [min5]);
  console.log(res, null, 2)
  const resList = await signal.kdj([types.Pair.BTC_JPY, types.Pair.LTC_BTC], symbolType, [min5]);
  console.log(resList, null, 2)
  // assert(resList.results.length === 2);
}

const testBitcoinKDJList = async () => {
  const symbols = ["btc_jpy", "xrp_jpy", "ltc_btc", "eth_btc", "mona_jpy", "mona_btc", "bcc_jpy", "bcc_btc"]
  const symbolType = types.SymbolType.cryptocoin;
  const units = [types.CandlestickUnit.Min5, types.CandlestickUnit.Min30, types.CandlestickUnit.Hour1, types.CandlestickUnit.Day1];
  const res = await signal.kdj(symbols, types.SymbolType.cryptocoin, units);
  console.log(JSON.stringify(res, null, 2))
}

describe('信号测试', () => {
  // it('获取5分钟数据', testGet5minData);
  // it('测试KDJ', testKDJ);
  // it('测试比特币KDJ', testBitcoinKDJ);
  it('测试比特币KDJ列表', testBitcoinKDJList);
});
