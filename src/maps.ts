/*
Copyright © BalaM314, 2025. All Rights Reserved.
Unfinished.
*/

import { FFunction } from './commands';
import { computeStatistics } from './funcs';
import { FishEvents } from './globals';
import { dataClass, serialize } from './io';
import { formatTime, match } from './utils';
import { Gamemode } from './config';

type FinishedMapRunData = {
	winTeam:Team;
	success:boolean; //winTeam == Vars.state.rules.defaultTeam
	startTime:number;
	endTime:number;
	maxPlayerCount:number;
	wave:number;
}
export class FinishedMapRun extends dataClass<FinishedMapRunData>() {
	wave = 0;
	duration(){
		return this.endTime - this.startTime;
	}
	outcome(){
		if(this.success) return ["win", "win"] as const;
		else if(this.winTeam === Team.derelict){
			if(this.duration() > 180_000) return ["loss", "late rtv"] as const;
			return ["rtv", "early rtv"] as const;
		} else return ["loss", "loss"] as const;
	}
}

export class PartialMapRun {
	static readonly key = "fish-partial-map-run";
	static current: PartialMapRun | null = null;
	static {
		FishEvents.on("saveData", () => {
			if(this.current) Core.settings.put(this.key, this.current.write());
		});
		FishEvents.on("loadData", () => {
			const data = Core.settings.getString(this.key);
			if(data){
				this.current = this.read(data);
			} else {
				//loading a map, but there is no run information, create one
				this.current = new this();
			}
		});
		Events.on(EventType.SaveLoadEvent, e => {
			//create a new run, if there isn't one already
			//loadData will have run first if it is a server restart
			this.current ??= new this();
		});
		Timer.schedule(() => {
			this.current?.update();
		}, 0, 5);
		Events.on(EventType.GameOverEvent, e => {
			if(this.current){
				//Add a new map run
				FMap.getCreate(Vars.state.map)?.runs.push(
					this.current.finish({winTeam: e.winner})
				);
			}
			Core.settings.remove(this.key);
			this.current = null;
		});
	}

	startTime:number = Date.now();
	maxPlayerCount:number = 0;
	/** In milliseconds */
	duration(){
		return Date.now() - this.startTime;
	}
	update(){
		this.maxPlayerCount = Math.max(this.maxPlayerCount, Groups.player.size());
	}
	finish({winTeam}:{
		winTeam: Team;
	}):FinishedMapRun {
		return new FinishedMapRun({
			winTeam,
			success: Gamemode.pvp() ? true : winTeam == Vars.state.rules.defaultTeam,
			startTime: this.startTime,
			endTime: Date.now(),
			maxPlayerCount: this.maxPlayerCount,
			wave: Vars.state.wave,
		});
	}
	//Used for continuing through a restart
	write():string {
		return `${Date.now() - this.startTime}/${this.maxPlayerCount}`;
	}
	static read(data:string):PartialMapRun {
		const [duration, maxPlayerCount] = data.split("/").map(Number);
		if(isNaN(duration) || isNaN(maxPlayerCount)){
			Log.err(`_FINDTAG_ failed to load map run stats data: ${data}`);
		}
		const out = new PartialMapRun();
		out.startTime = Date.now() - duration; //move start time forward by time when the server was off
		out.maxPlayerCount = maxPlayerCount;
		return out;
	}
}


type FMapData = {
	runs: FinishedMapRun[];
	mapFileName: string;
};
export class FMap extends dataClass<FMapData>() {
	constructor(
		data:FMapData,
		//O(n^2)... should be fine?
		public map:MMap | null = Vars.maps.customMaps().find(m => m.file.name() === data.mapFileName)
	){ super(data); }

	@serialize("fish-map-data", () => ["version", 1, ["array", "u16", ["class", FMap, [
		["runs", ["array", "u32", ["class", FinishedMapRun, [
			["startTime", ["number", "i64"]],
			["endTime", ["number", "i64"]],
			["maxPlayerCount", ["number", "u8"]],
			["success", ["boolean"]],
			["winTeam", ["team"]],
			["wave", ["number", "u16"]]
		]]]],
		["mapFileName", ["string"]],
	]]]], () => ["array", "u16", ["class", FMap, [
		["runs", ["array", "u32", ["class", FinishedMapRun, [
			["startTime", ["number", "i64"]],
			["endTime", ["number", "i64"]],
			["maxPlayerCount", ["number", "u8"]],
			["success", ["boolean"]],
			["winTeam", ["team"]],
		]]]],
		["mapFileName", ["string"]],
	]]])
	static allMaps:FMap[] = [];
	private static maps:Record<string, FMap> = {};
	static {
		FishEvents.on("dataLoaded", () => {
			//This event listener runs after the data has been loaded into allMaps
			FMap.allMaps.forEach(map => {
				FMap.maps[map.mapFileName] = map;
			});
			//create all the data
			Vars.maps.customMaps().each(m => void FMap.getCreate(m));
		});
	}

	static getCreate(map:MMap){
		const mapFileName = map.file.name();
		if(Object.prototype.hasOwnProperty.call(this.maps, mapFileName))
			return this.maps[mapFileName];
		const fmap = new this({
			runs: [],
			mapFileName
		}, map);
		this.maps[mapFileName] = fmap;
		this.allMaps.push(fmap);
		return fmap;
	}

	rules():Rules | undefined {
		return this.map?.rules();
	}

	stats(){
		const allRunCount = this.runs.length;
		const victories = this.runs.filter(r => r.outcome()[1] === "win").length;
		const losses = this.runs.filter(r => r.outcome()[0] === "loss").length;
		const earlyRTVs = this.runs.filter(r => r.outcome()[1] === "early rtv").length;
		const lateRTVs = this.runs.filter(r => r.outcome()[1] === "late rtv").length;
		const significantRunCount = allRunCount - earlyRTVs;
		const totalLosses = losses + lateRTVs;
		const durations = this.runs.filter(r => r.outcome()[0] !== "rtv").map(r => r.duration() / 1000); //convert to seconds
		const durationStats = computeStatistics(durations);
		const teamWins = this.runs.filter(r => r.success).reduce((acc, item) => {
			acc[item.winTeam.name] = (acc[item.winTeam.name] ?? 0) + 1;
			return acc;
		}, {} as Record<string, number>);
		const teamWinRate = Object.fromEntries(Object.entries(teamWins).map(([team, wins]) => [team, wins / victories]));
		return {
			allRunCount,
			significantRunCount,
			victories,
			losses,
			totalLosses,
			earlyRTVs,
			lateRTVs,
			earlyRTVRate: earlyRTVs / allRunCount,
			winRate: victories / significantRunCount,
			lossRate: losses / significantRunCount,
			averagePlaytime: durationStats.average,
			shortestWinTime: Math.min(...this.runs.filter(r => r.outcome()[0] === "win").map(r => r.duration())),
			longestTime: durationStats.highest,
			shortestTime: durationStats.lowest,
			averageHighestPlayerCount: computeStatistics(this.runs.map(r => r.maxPlayerCount)).average,
			teamWins,
			teamWinRate,
		};
	}
	displayStats(f:FFunction):string | null {
		const map = this.map; if(!map) return null;
		const stats = this.stats();
		const rules = this.rules()!;

		const modeSpecificStats = match(Gamemode.name(), {
			attack: `\
[accent]Total runs: ${stats.allRunCount} (${stats.victories} wins, ${stats.totalLosses} losses, ${stats.earlyRTVs} RTVs)
[accent]Outcomes: ${f.percent(stats.winRate, 1)} wins, ${f.percent(stats.lossRate, 1)} losses, ${f.percent(stats.earlyRTVRate, 1)} RTVs
[accent]Average playtime: ${formatTime(stats.averagePlaytime)}
[accent]Shortest win time: ${formatTime(stats.shortestWinTime)}`,
			survival: `\
[accent]Total runs: ${stats.allRunCount} (${stats.earlyRTVs} RTVs)
[accent]RTV rate: ${f.percent(stats.earlyRTVRate, 1)}
[accent]Average duration: ${formatTime(stats.averagePlaytime)}
[accent]Longest duration: ${formatTime(stats.longestTime)}`,
			pvp: `\
[accent]Total runs: ${stats.allRunCount} (${stats.earlyRTVs} RTVs)
[accent]Team win rates: ${Object.entries(stats.teamWinRate).map(([team, rate]) => `${team} ${f.percent(rate, 1)}`).join(", ")}
[accent]RTV rate: ${f.percent(stats.earlyRTVRate, 1)}
[accent]Average match duration: ${formatTime(stats.averagePlaytime)}
[accent]Shortest match duration: ${formatTime(stats.shortestWinTime)}`,
			hexed: `\
[accent]Total runs: ${stats.allRunCount} (${stats.earlyRTVs} RTVs)
[accent]RTV rate: ${f.percent(stats.earlyRTVRate, 1)}
[accent]Average match duration: ${formatTime(stats.averagePlaytime)}
[accent]Shortest match duration: ${formatTime(stats.shortestWinTime)}`,
			sandbox: `\
[accent]Total plays: ${stats.allRunCount}
[accent]Average play time: ${formatTime(stats.averagePlaytime)}
[accent]Shortest play time: ${formatTime(stats.shortestTime)}`,
		}, "");
		return (`\
[coral]Information for map ${map.name()} [gray](${map.file.name()})[coral]:
[accent]Map by: ${map.author()}
[accent]Description: ${map.description()}
[accent]Size: ${map.width}x${map.height}
[accent]Last updated: ${new Date(map.file.lastModified()).toLocaleDateString()}
[accent]BvB allowed: ${f.boolGood(rules.placeRangeCheck)}, unit item transfer allowed: ${f.boolGood(rules.onlyDepositCore)}

${modeSpecificStats}
[accent]Longest play time: ${formatTime(stats.longestTime)}
[accent]Average player count: ${stats.averageHighestPlayerCount}`
		);
	}
}
