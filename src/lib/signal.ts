import { IResults } from 'influx';
import * as assert from 'power-assert';
import * as numeral from 'numeral';
import * as moment from 'moment';

import * as types from 'ns-types';
import { InfluxDB, Param, Enums } from 'ns-influxdb';
import { SniperStrategy, SniperSignal } from 'ns-strategies';

const Loki = require('lokijs');
const bitbank = require('node-bitbankcc');
const pubApi = bitbank.publicApi();

type OHLCV = [number, number, number, number, number];

export interface IKdjOutput extends SniperSignal {
  symbolType?: types.SymbolType
  lastTime?: string;
  lastPrice?: number;
}
export class Signal {

  backtest: {
    test: boolean,
    isLastDate: string,
    date: string,
    interval: number,
    loki: any
  };
  influxdb: InfluxDB;

  constructor(config: { [Attr: string]: any }) {
    assert(config, 'config required.');
    assert(config.influxdb, 'config.influxdb required.');
    assert(config.backtest, 'config.backtest required.');
    assert(config.strategies, 'config.strategies required.');
    assert(config.store, 'config.store required.');
    this.backtest = config.backtest;
    this.influxdb = new InfluxDB(config.influxdb);
    // 回测模式时，启动临时中间数据库
    if (this.backtest.test) {
      this.backtest.loki = new Loki('backtest.db');
    }
  }

  async kdj(symbol: string | string[], type: types.SymbolType, timeUnit: types.CandlestickUnit) {
    if (typeof symbol === 'string' || symbol.length === 1) {
      let hisData: types.Bar[];
      if (type === types.SymbolType.stock) {
        hisData = <types.Bar[]>await this.getCq5minData(symbol);
      } else if (type === types.SymbolType.cryptocoin) {
        hisData = await this.getCoinHisData(<types.Pair>symbol, timeUnit);
      } else {
        throw new Error('未对应商品类型');
      }
      return await this.executeKDJ(hisData, type);
    } else {
      let hisDataList: types.Bar[][];
      if (type === types.SymbolType.stock) {
        hisDataList = <types.Bar[][]>await this.getCq5minData(symbol);
        const signalList = [];
        for (const hisData of hisDataList) {
          signalList.push(await this.executeKDJ(hisData, type));
        }
        return signalList;
      } else if (type === types.SymbolType.cryptocoin) {
        const signalList = [];
        for (const sym of symbol) {
          const hisData = await this.getCoinHisData(<types.Pair>sym, timeUnit);
          signalList.push(await this.executeKDJ(hisData, type));
        }
        return signalList;
      } else {
        throw new Error('未对应商品类型');
      }
    }
  }

  private async executeKDJ(hisData: types.Bar[], type: types.SymbolType) {
    const signal = <IKdjOutput>Object.assign({}, SniperStrategy.execute('', hisData));
    if (hisData.length > 0 && hisData[hisData.length - 1]) {
      signal.lastTime = moment(hisData[hisData.length - 1].time).format('YYYY-MM-DD HH:mm:ss');
      signal.lastPrice = numeral(hisData[hisData.length - 1].close).value();
    }
    signal.symbolType = type;
    return signal;
  }

  private async getCoinHisData(symbol: types.Pair, unit: types.CandlestickUnit) {
    const data = await pubApi.getCandlestick(symbol, unit, moment.utc().format('YYYYMMDD'));
    const ohlchList: OHLCV[] = data.candlestick[0].ohlcv;
    const bars: types.Bar[] = [];
    for (const ohlch of ohlchList) {
      if (ohlch[4]) {
        bars.push({
          open: ohlch[0],
          high: ohlch[1],
          low: ohlch[2],
          close: ohlch[3],
          volume: ohlch[4],
          time: ohlch[5]
        });
      }
    }
    return bars;
  }

  async _getTest5minData(symbol: string): Promise<types.Bar[]> {

    let hisData: types.Bar[] = [];
    // 取最近一日数据
    if (this.backtest.isLastDate) {
      const query = `select * from ${Enums.Measurement.Candlestick_5min} where time > now() - 24h and symbol = '${symbol}'`;
      hisData = <types.Bar[]>await this._getCq5minData(query);
    } else if (this.backtest.date) {
      const query = `select * from ${Enums.Measurement.Candlestick_5min} where time > now() - 64h and symbol = '${symbol}'`;
      hisData = <types.Bar[]>await this._getCq5minData(query);
    }
    return hisData;
  }

  async getTest5minData(symbol: string): Promise<types.Bar[]> {
    const loki = this.backtest.loki;
    const inCollName = 'i_' + symbol;

    let inColl = loki.getCollection(inCollName);
    let hisData: types.Bar[] = [];
    // 股票输入表为空时，通过接口获取数据
    if (!inColl) {
      hisData = await this._getTest5minData(symbol);
      if (hisData.length === 0) {
        throw new Error('回测环境未获取5分钟线数据！');
      }
      inColl = loki.addCollection(inCollName);
      inColl.insert(JSON.parse(JSON.stringify(hisData)));
    } else {
      hisData = inColl.chain().find().data({ removeMeta: true });
    }
    // 取出数据导入输出表
    let outColl = loki.getCollection(symbol);
    if (!outColl) {
      outColl = loki.addCollection(symbol);
      // 插入第一条数据
      outColl.insert(hisData[0]);
    } else {
      const insertData = hisData[outColl.find().length];
      if (insertData) {
        outColl.insert(insertData);
      }
    }
    return <types.Bar[]>outColl.chain().find().data({ removeMeta: true });
  }

  async _getCq5minData(query: string | string[]): Promise<types.Bar[] | types.Bar[][]> {
    if (typeof query === 'string' || query.length === 1) {
      if (query.length === 1) {
        query = query[0];
      }
      const res = await this.influxdb.connection.query(String(query));
      const barList: types.Bar[] = [];
      res.forEach(el => {
        barList.push(<types.Bar>el);
      });
      return barList;
    } else {
      const resList = await this.influxdb.connection.query(query);
      const symbolList = [];
      for (const res of resList) {
        const barList: types.Bar[] = [];
        res.forEach(el => {
          barList.push(<types.Bar>el);
        });
        symbolList.push(barList);
      }
      return symbolList;
    }
  }

  getCq5minQuery = (symbol: string) => `
    select * from
      ${Enums.Measurement.Candlestick_5min} 
    where time > now() - 12h and symbol = '${symbol}'
  `;
  async getCq5minData(symbol: string | string[]): Promise<types.Bar[] | types.Bar[][]> {
    if (typeof symbol === 'string' || symbol.length === 1) {
      if (symbol.length === 1) {
        symbol = symbol[0];
      }
      const query = this.getCq5minQuery(String(symbol));
      return await this._getCq5minData(query);
    } else {
      const queryList = [];
      for (const sym of symbol) {
        queryList.push(this.getCq5minQuery(sym));
      }
      return await this._getCq5minData(queryList);
    }
  }

  async get5minData(symbol: string | string[]): Promise<types.Bar[] | types.Bar[][]> {
    if (typeof symbol === 'string' || symbol.length === 1) {
      if (this.backtest.test) {
        // return await this.getTest5minData(symbol);
      }
      const hisData: types.Bar[] = new Array();
      const res = <types.Bar[]>await this.getCq5minData(symbol);
      res.forEach(el => {
        hisData.push(<types.Bar>el);
      });
      return hisData;
    } else {
      if (this.backtest.test) {
        // return await this.getTest5minData(symbol);
      }
      const resList = <types.Bar[][]>await this.getCq5minData(symbol);
      const symbolList = [];
      for (const res of resList) {
        const barList: types.Bar[] = [];
        res.forEach(el => {
          barList.push(<types.Bar>el);
        });
        symbolList.push(barList);
      }
      return symbolList;
    }
  }
}
