declare module 'drawflow' {
  class Drawflow {
    constructor(element: HTMLElement, render?: any, parent?: any);
    start(): void;
    import(data: any): void;
    export(): any;
    addNode(name: string, inputs: number, outputs: number, posX: number, posY: number, className: string, data: any, html: string, typeNode?: boolean): number;
    removeNodeId(id: string): void;
    updateNodeDataFromId(id: number | string, data: any): void;
    getNodeFromId(id: number | string): any;
    on(event: string, callback: (...args: any[]) => void): void;
    zoom_in(): void;
    zoom_out(): void;
    zoom_reset(): void;
    clear(): void;
    editor_mode: string;
    drawflow: any;
    [key: string]: any;
  }
  export default Drawflow;
}
declare module 'drawflow/dist/drawflow.min.css';
