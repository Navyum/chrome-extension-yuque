文本图文档

  

plantuml

```plantuml
@startuml
allowmixing

actor     用户
usecase   用例

json JSON {
   "水果":"苹果",
   "尺寸":"大",
   "颜色": ["红", "绿"]
}
@enduml

```

![图表](https://cdn.nlark.com/yuque/__puml/fb1e3dd5c6c3c2e1103a161bf0734287.svg)

  

plantuml2

​  

```plantuml
@startuml
left to right direction
actor Guest as g
package Professional {
  actor Chef as c
  actor "Food Critic" as fc
}
package Restaurant {
  usecase "Eat Food" as UC1
  usecase "Pay for Food" as UC2
  usecase "Drink" as UC3
  usecase "Review" as UC4
}
fc --> UC4
g --> UC1
g --> UC2
g --> UC3
@enduml

```

![图表](https://cdn.nlark.com/yuque/__puml/73a8bfb64111871e4d7d0da018ff4711.svg)

  

  

```plantuml
@startuml

robust "Web 浏览器" as WB
concise "Web 用户" as WU

@0
WU is 空闲
WB is 空闲

@100
WU is 等待中
WB is 处理中

@300
WB is 等待中

@enduml
```

![图表](https://cdn.nlark.com/yuque/__puml/0ce7aa997ac3a7c3a1b665ca29fc3f8a.svg)

  

```mermaid
sequenceDiagram
  participant User as 用户
  participant Browser as 浏览器
  participant Server as 服务端
  User->>Browser: 输入 URL
  Browser->>Server: 请求服务器
  Server->>Server: 模板渲染
  Server->>Browser: 返回 HTML
  Browser->>User
```

![图表](https://cdn.nlark.com/yuque/__puml/b11b6192390c95750c4b71c2580ff529.svg)

  

```plantuml
@startuml

actor A
actor B

A -up-> (up)
A -right-> (center)
A -down-> (down)
A -left-> (left)

B -up-> (up)
B -left-> (center)
B -right-> (right)
B -down-> (down)

@enduml
```

![图表](https://cdn.nlark.com/yuque/__puml/a7908b49c22b05104624bebc463cd25d.svg)

  

```plantuml
@startuml

class Car {
  color
  model
  +start()
  #run()
  #stop()
}

Car <|- Bus
Car *-down- Tire
Car *-down- Engine
Bus o-down- Driver

@enduml
```

![图表](https://cdn.nlark.com/yuque/__puml/e9cf4eba3cdaf0cf1bc68065406d9d43.svg)

  

```plantuml
@startuml

start

:step 1;

if (try) then (true)
  :step 2;
  :step 3;
else (false)
  :error;
  end
endif

stop

@enduml
```

![图表](https://cdn.nlark.com/yuque/__puml/48a1408972f20bc1f4837aa807254692.svg)

  

```plantuml
@startuml

|A Section|
start
:step1;
|#AntiqueWhite|B Section|
:step2;
:step3;
|A Section|
:step4;
|B Section|
:step5;
stop

@enduml
```

![图表](https://cdn.nlark.com/yuque/__puml/2aa76dcc256f08335083bd039b5b4e49.svg)

  

```plantuml
@startuml

DataAccess - [First Component]
[First Component] ..> HTTP : use

@enduml
```

![图表](https://cdn.nlark.com/yuque/__puml/5652e52556f8c433cbc53e2a6f755d25.svg)

  

```plantuml
@startuml

[*] --> State1
State1 --> [*]
State1 : this is a string
State1 : this is another string

State1 -> State2
State2 --> [*]

@enduml
```

![图表](https://cdn.nlark.com/yuque/__puml/0d1c26fb399ed9669a2e1a29e98b4de4.svg)

```plantuml
@startuml

object Car
object Bus
object Tire
object Engine
object Driver

Car <|- Bus
Car *-down- Tire
Car *-down- Engine
Bus o-down- Driver

@enduml
```

![图表](https://cdn.nlark.com/yuque/__puml/1af2d7ebc3e554c752289bcce7679cdb.svg)

```plantuml
@startuml

actor A
actor B

A -up-> (up)
A -right-> (center)
A -down-> (down)
A -left-> (left)

B -up-> (up)
B -left-> (center)
B -right-> (right)
B -down-> (down)

@enduml
```

![图表](https://cdn.nlark.com/yuque/__puml/a7908b49c22b05104624bebc463cd25d.svg)

  

  

mermaid

```mermaid
graph TD
      A[Start] --> B{Is it?};
      B -->|Yes| C[OK];
      C --> D[Rethink];
      D --> B;
      B ---->|No| E[End];
```

![图表](https://cdn.nlark.com/yuque/__mermaid_v3/fc37b792da1a20303a503337c7814525.svg)

```mermaid
sequenceDiagram
      participant John
      participant Alice
      Alice->>John: Hello John, how are you?
      John-->>Alice: Great!
```

![图表](https://cdn.nlark.com/yuque/__mermaid_v3/8f6c0fcc8ec1c27d48b9d9e101e10757.svg)

  

```mermaid
classDiagram
      Animal <|-- Duck
      Animal <|-- Fish
      Animal <|-- Zebra
      Animal : +int age
      Animal : +String gender
      Animal: +isMammal()
      Animal: +mate()
      class Duck{
          +String beakColor
          +swim()
          +quack()
      }
      class Fish{
          -int sizeInFeet
          -canEat()
      }
      class Zebra{
          +bool is_wild
          +run()
      }
```

![图表](https://cdn.nlark.com/yuque/__mermaid_v3/a056a7ec3b4d1e6aa8d831e3151928ac.svg)

```mermaid
stateDiagram-v2
      [*] --> Still
      Still --> [*]

      Still --> Moving
      Moving --> Still
      Moving --> Crash
      Crash --> [*]
```

![图表](https://cdn.nlark.com/yuque/__mermaid_v3/1a0a45a175c396280f490989f60585d6.svg)

```mermaid
erDiagram
      CUSTOMER ||--o{ ORDER : places
      ORDER ||--|{ LINE-ITEM : contains
      CUSTOMER }|..|{ DELIVERY-ADDRESS : uses
```

![图表](https://cdn.nlark.com/yuque/__mermaid_v3/b6266f590955858f37399dbd3ca2e522.svg)

```mermaid
gantt
      title A Gantt Diagram
      dateFormat  YYYY-MM-DD
      section Section
      A task           :a1, 2014-01-01, 30d
      Another task     :after a1  , 20d
      section Another
      Task in sec      :2014-01-12  , 12d
      another task      : 24d
```

![图表](https://cdn.nlark.com/yuque/__mermaid_v3/10b824e2572e99b176752d05c2ff2f79.svg)

```mermaid
pie
      title Key elements in Product X
      "Calcium" : 42.96
      "Potassium" : 50.05
      "Magnesium" : 10.01
      "Iron" :  5
```

![图表](https://cdn.nlark.com/yuque/__mermaid_v3/bad5fafa3e56e58587985aa23399a7f2.svg)

  

flowchart

```flowchart
st=>start: Start
  e=>end
  op1=>operation: My Operation
  sub1=>subroutine: My Subroutine
  cond=>condition: Yes or No?
  io=>inputoutput: catch something...
  para=>parallel: parallel tasks

  st->op1->cond
  cond(yes)->io->e
  cond(no)->para
  para(path1, bottom)->sub1(right)->op1
  para(path2, top)->op1
```

![图表](https://cdn.nlark.com/yuque/__flowchart/15ccc4a6aa44c1adafcd9d4069072688.svg)

  

graphviz

```graphviz
digraph finite_state_machine {
	rankdir=LR;
	size="8,5"
	node [shape = doublecircle]; LR_0 LR_3 LR_4 LR_8;
	node [shape = circle];
	LR_0 -> LR_2 [ label = "SS(B)" ];
	LR_0 -> LR_1 [ label = "SS(S)" ];
	LR_1 -> LR_3 [ label = "S($end)" ];
	LR_2 -> LR_6 [ label = "SS(b)" ];
	LR_2 -> LR_5 [ label = "SS(a)" ];
	LR_2 -> LR_4 [ label = "S(A)" ];
	LR_5 -> LR_7 [ label = "S(b)" ];
	LR_5 -> LR_5 [ label = "S(a)" ];
	LR_6 -> LR_6 [ label = "S(b)" ];
	LR_6 -> LR_5 [ label = "S(a)" ];
	LR_7 -> LR_8 [ label = "S(b)" ];
	LR_7 -> LR_5 [ label = "S(a)" ];
	LR_8 -> LR_6 [ label = "S(b)" ];
	LR_8 -> LR_5 [ label = "S(a)" ];
}
```

![图表](https://cdn.nlark.com/yuque/__graphviz/0505d12755ead51c3abdf6823dc88e11.svg)
