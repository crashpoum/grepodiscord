import { buildSnapshot, type WorldFiles } from '../src/data/snapshot.js';

export const files = (over: Partial<WorldFiles> = {}): WorldFiles => ({
  players: ['1,Alice,10,1000,1,2', '2,Bob+the+Great,,500,2,1', '3,Cara%27s,20,200,3,1'].join('\n'),
  alliances: ['10,Red+Team,1000,2,1,1', '20,Blue,200,1,1,2'].join('\n'),
  towns: [
    '100,1,Alice+1,450,530,1,600', // ocean 45
    '101,1,Alice+2,460,540,2,400', // ocean 45
    '200,2,Bob+town,120,880,3,500', // ocean 18
    '300,3,Cara+GDK7Q2,455,535,4,200', // ocean 45, contains a verification code
    '400,,Ghost+A,452,532,5,900', // ghost, ocean 45
    '401,,Ghost+B,800,100,6,300', // ghost, ocean 81
  ].join('\n'),
  conquers: ['100,1000,1,3,10,20,600', '200,2000,2,,,,500', '300,3000,3,3,20,20,200'].join('\n'),
  player_kills_att: ['1,1,5000', '2,2,100'].join('\n'),
  player_kills_def: ['1,1,300', '2,3,50'].join('\n'),
  alliance_kills_att: '1,10,5000',
  alliance_kills_def: '1,10,300',
  ...over,
});

export const snap = (over: Partial<WorldFiles> = {}) => buildSnapshot('en999', files(over));
