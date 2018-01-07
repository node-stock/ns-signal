import { IResults } from 'influx';
import * as assert from 'power-assert';
import * as numeral from 'numeral';
import * as moment from 'moment';
import { Log, Util } from 'ns-common';

import * as types from 'ns-types';
import { InfluxDB, Param, Enums } from 'ns-influxdb';
import { SniperStrategy, ISniperStrategy } from 'ns-strategies';
import { BitbankPublicApiHandler, BitbankApiCandlestickType, BitbankApiCandlestick } from 'bitbank-handler';

const Loki = require('lokijs');
const pubApi = new BitbankPublicApiHandler();

export { ISniperStrategy };

export interface IKdjSignal {
  symbol: string;
  symbolType: types.SymbolType;
  results: IKdjOutput[]
}

export interface IKdjOutput {
  timeframe: types.CandlestickUnit;
  lastTime?: string;
  lastPrice?: string;
  strategy?: ISniperStrategy
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
    this.backtest = config.backtest;
    this.influxdb = new InfluxDB(config.influxdb);
    // 回测模式时，启动临时中间数据库
    if (this.backtest.test) {
      this.backtest.loki = new Loki('backtest.db');
    }
  }

  async kdj(symbol: string | string[], type: types.SymbolType, timeUnits: types.CandlestickUnit[]): Promise<IKdjSignal[]> {
    const kdjSignals: IKdjSignal[] = [];
    // 查询单个商品
    if (typeof symbol === 'string' || symbol.length === 1) {
      const kdjSignal: IKdjSignal = {
        symbol: typeof symbol === 'string' ? symbol : symbol[0],
        symbolType: type,
        results: []
      };
      for (const timeUnit of timeUnits) {
        let hisData: types.Bar[];
        if (type === types.SymbolType.stock) {
          hisData = <types.Bar[]>await this.getCq5minData(symbol);
        } else if (type === types.SymbolType.cryptocoin) {
          hisData = await this.getCoinHisData(<types.Pair>symbol, timeUnit);
        } else {
          throw new Error('未对应商品类型');
        }

        const kdjOutput = await this.executeKDJ(hisData, timeUnit);
        kdjSignal.results.push(kdjOutput);
      }
      kdjSignals.push(kdjSignal);
    } else { // 查询多条商品
      if (type === types.SymbolType.stock) {
        const hisDataList = <types.Bar[][]>await this.getCq5minData(symbol);
        for (const [index, hisData] of hisDataList.entries()) {
          const kdjSignal: IKdjSignal = {
            symbol: symbol[index],
            symbolType: type,
            results: []
          };
          for (const timeUnit of timeUnits) {
            const kdjOutput = await this.executeKDJ(hisData, timeUnit);
            kdjSignal.results.push(kdjOutput);
          }
          kdjSignals.push(kdjSignal);
        }
      } else if (type === types.SymbolType.cryptocoin) {
        const signalList = [];
        for (const sym of symbol) {
          const kdjSignal: IKdjSignal = {
            symbol: sym,
            symbolType: type,
            results: []
          };
          for (const timeUnit of timeUnits) {
            const hisData = await this.getCoinHisData(<types.Pair>sym, timeUnit);
            const kdjOutput = await this.executeKDJ(hisData, timeUnit);
            kdjSignal.results.push(kdjOutput);
          }
          kdjSignals.push(kdjSignal);
        }
      } else {
        throw new Error('未对应商品类型');
      }
    }
    return kdjSignals;
  }

  private async executeKDJ(hisData: types.Bar[], timeUnit: types.CandlestickUnit) {
    const strategy = SniperStrategy.execute(hisData);
    const kdjOutput: IKdjOutput = {
      timeframe: timeUnit,
      strategy
    }
    if (hisData.length > 0 && hisData[hisData.length - 1]) {
      kdjOutput.lastTime = moment(hisData[hisData.length - 1].time).format('YYYY-MM-DD HH:mm:ss');
      kdjOutput.lastPrice = String(hisData[hisData.length - 1].close);
    }
    return kdjOutput;
  }

  private async getCoinHisData(symbol: types.Pair, unit: types.CandlestickUnit) {
    const bars: types.Bar[] = [];
    let data: BitbankApiCandlestick = {
      candlestick: []
    };
    switch (unit) {
      case types.CandlestickUnit.Min1:
      case types.CandlestickUnit.Min5:
      case types.CandlestickUnit.Min15:
      case types.CandlestickUnit.Min30:
      case types.CandlestickUnit.Hour1:
        data = await pubApi.getCandlestick(symbol, unit, moment.utc().format('YYYYMMDD')).toPromise();
        break;
      case types.CandlestickUnit.Hour4:
      case types.CandlestickUnit.Hour8:
      case types.CandlestickUnit.Hour12:
      case types.CandlestickUnit.Day1:
      case types.CandlestickUnit.Week1:
        data = await pubApi.getCandlestick(symbol, unit, moment.utc().format('YYYY')).toPromise();
        break;
    }
    if (data.candlestick.length === 0) {
      Log.system.error('未找到candlestick数据!')
      return bars;
    }

    let ohlchList = data.candlestick[0].ohlcv;
    ohlchList = ohlchList.slice(ohlchList.length - 21, ohlchList.length - 1);
    for (const ohlch of ohlchList) {
      if (ohlch[4]) {
        bars.push({
          open: Number(ohlch[0]),
          high: Number(ohlch[1]),
          low: Number(ohlch[2]),
          close: Number(ohlch[3]),
          volume: Number(ohlch[4]),
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
